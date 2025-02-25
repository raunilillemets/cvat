# Copyright (C) 2018 Intel Corporation
#
# SPDX-License-Identifier: MIT

import os
from enum import Enum
from django.utils import timezone
from PIL import Image

from django.conf import settings
from django.db import transaction

from cvat.apps.profiler import silk_profile
from cvat.apps.engine.plugins import plugin_decorator
from cvat.apps.annotation.annotation import AnnotationIR, Annotation

from . import models
from .data_manager import DataManager
from .log import slogger
from . import serializers
from .utils.import_modules import import_modules

class PatchAction(str, Enum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"

    @classmethod
    def values(cls):
        return [item.value for item in cls]

    def __str__(self):
        return self.value

@silk_profile(name="GET job data")
@transaction.atomic
def get_job_data(pk, user):
    annotation = JobAnnotation(pk, user)
    annotation.init_from_db()

    return annotation.data

@silk_profile(name="POST job data")
@transaction.atomic
def put_job_data(pk, user, data):
    annotation = JobAnnotation(pk, user)
    annotation.put(data)

    return annotation.data

@silk_profile(name="UPDATE job data")
@plugin_decorator
@transaction.atomic
def patch_job_data(pk, user, data, action):
    annotation = JobAnnotation(pk, user)
    if action == PatchAction.CREATE:
        annotation.create(data)
    elif action == PatchAction.UPDATE:
        annotation.update(data)
    elif action == PatchAction.DELETE:
        annotation.delete(data)

    return annotation.data

@silk_profile(name="DELETE job data")
@transaction.atomic
def delete_job_data(pk, user):
    annotation = JobAnnotation(pk, user)
    annotation.delete()

@silk_profile(name="GET task data")
@transaction.atomic
def get_task_data(pk, user):
    annotation = TaskAnnotation(pk, user)
    annotation.init_from_db()

    return annotation.data

@silk_profile(name="POST task data")
@transaction.atomic
def put_task_data(pk, user, data):
    annotation = TaskAnnotation(pk, user)
    annotation.put(data)

    return annotation.data

@silk_profile(name="UPDATE task data")
@transaction.atomic
def patch_task_data(pk, user, data, action):
    annotation = TaskAnnotation(pk, user)
    if action == PatchAction.CREATE:
        annotation.create(data)
    elif action == PatchAction.UPDATE:
        annotation.update(data)
    elif action == PatchAction.DELETE:
        annotation.delete(data)

    return annotation.data

@transaction.atomic
def load_task_data(pk, user, filename, loader):
    annotation = TaskAnnotation(pk, user)
    annotation.upload(filename, loader)

@transaction.atomic
def load_job_data(pk, user, filename, loader):
    annotation = JobAnnotation(pk, user)
    annotation.upload(filename, loader)

@silk_profile(name="DELETE task data")
@transaction.atomic
def delete_task_data(pk, user):
    annotation = TaskAnnotation(pk, user)
    annotation.delete()

def dump_task_data(pk, user, filename, dumper, scheme, host):
    # For big tasks dump function may run for a long time and
    # we dont need to acquire lock after _AnnotationForTask instance
    # has been initialized from DB.
    # But there is the bug with corrupted dump file in case 2 or more dump request received at the same time.
    # https://github.com/opencv/cvat/issues/217
    with transaction.atomic():
        annotation = TaskAnnotation(pk, user)
        annotation.init_from_db()

    annotation.dump(filename, dumper, scheme, host)

def bulk_create(db_model, objects, flt_param):
    if objects:
        if flt_param:
            if 'postgresql' in settings.DATABASES["default"]["ENGINE"]:
                return db_model.objects.bulk_create(objects)
            else:
                ids = list(db_model.objects.filter(**flt_param).values_list('id', flat=True))
                db_model.objects.bulk_create(objects)

                return list(db_model.objects.exclude(id__in=ids).filter(**flt_param))
        else:
            return db_model.objects.bulk_create(objects)

    return []

def _merge_table_rows(rows, keys_for_merge, field_id):
    """dot.notation access to dictionary attributes"""
    from collections import OrderedDict
    class dotdict(OrderedDict):
        __getattr__ = OrderedDict.get
        __setattr__ = OrderedDict.__setitem__
        __delattr__ = OrderedDict.__delitem__
        __eq__ = lambda self, other: self.id == other.id
        __hash__ = lambda self: self.id

    # It is necessary to keep a stable order of original rows
    # (e.g. for tracked boxes). Otherwise prev_box.frame can be bigger
    # than next_box.frame.
    merged_rows = OrderedDict()

    # Group all rows by field_id. In grouped rows replace fields in
    # accordance with keys_for_merge structure.
    for row in rows:
        row_id = row[field_id]
        if not row_id in merged_rows:
            merged_rows[row_id] = dotdict(row)
            for key in keys_for_merge:
                merged_rows[row_id][key] = []

        for key in keys_for_merge:
            item = dotdict({v.split('__', 1)[-1]:row[v] for v in keys_for_merge[key]})
            if item.id is not None:
                merged_rows[row_id][key].append(item)

    # Remove redundant keys from final objects
    redundant_keys = [item for values in keys_for_merge.values() for item in values]
    for i in merged_rows:
        for j in redundant_keys:
            del merged_rows[i][j]

    return list(merged_rows.values())

class JobAnnotation:
    def __init__(self, pk, user):
        self.user = user
        self.db_job = models.Job.objects.select_related('segment__task') \
            .select_for_update().get(id=pk)

        db_segment = self.db_job.segment
        self.start_frame = db_segment.start_frame
        self.stop_frame = db_segment.stop_frame
        self.ir_data = AnnotationIR()

        # pylint: disable=bad-continuation
        self.logger = slogger.job[self.db_job.id]
        self.db_labels = {db_label.id:db_label
            for db_label in db_segment.task.label_set.all()}
        self.db_attributes = {db_attr.id:db_attr
            for db_attr in models.AttributeSpec.objects.filter(
                label__task__id=db_segment.task.id)}

    def reset(self):
        self.ir_data.reset()

    def _save_tracks_to_db(self, tracks):
        db_tracks = []
        db_track_attrvals = []
        db_shapes = []
        db_shape_attrvals = []

        for track in tracks:
            track_attributes = track.pop("attributes", [])
            shapes = track.pop("shapes")
            db_track = models.LabeledTrack(job=self.db_job, **track)
            if db_track.label_id not in self.db_labels:
                raise AttributeError("label_id `{}` is invalid".format(db_track.label_id))

            for attr in track_attributes:
                db_attrval = models.LabeledTrackAttributeVal(**attr)
                if db_attrval.spec_id not in self.db_attributes:
                    raise AttributeError("spec_id `{}` is invalid".format(db_attrval.spec_id))
                db_attrval.track_id = len(db_tracks)
                db_track_attrvals.append(db_attrval)

            for shape in shapes:
                shape_attributes = shape.pop("attributes", [])
                # FIXME: need to clamp points (be sure that all of them inside the image)
                # Should we check here or implement a validator?
                db_shape = models.TrackedShape(**shape)
                db_shape.track_id = len(db_tracks)

                for attr in shape_attributes:
                    db_attrval = models.TrackedShapeAttributeVal(**attr)
                    if db_attrval.spec_id not in self.db_attributes:
                        raise AttributeError("spec_id `{}` is invalid".format(db_attrval.spec_id))
                    db_attrval.shape_id = len(db_shapes)
                    db_shape_attrvals.append(db_attrval)

                db_shapes.append(db_shape)
                shape["attributes"] = shape_attributes

            db_tracks.append(db_track)
            track["attributes"] = track_attributes
            track["shapes"] = shapes

        db_tracks = bulk_create(
            db_model=models.LabeledTrack,
            objects=db_tracks,
            flt_param={"job_id": self.db_job.id}
        )

        for db_attrval in db_track_attrvals:
            db_attrval.track_id = db_tracks[db_attrval.track_id].id
        bulk_create(
            db_model=models.LabeledTrackAttributeVal,
            objects=db_track_attrvals,
            flt_param={}
        )

        for db_shape in db_shapes:
            db_shape.track_id = db_tracks[db_shape.track_id].id

        db_shapes = bulk_create(
            db_model=models.TrackedShape,
            objects=db_shapes,
            flt_param={"track__job_id": self.db_job.id}
        )

        for db_attrval in db_shape_attrvals:
            db_attrval.shape_id = db_shapes[db_attrval.shape_id].id

        bulk_create(
            db_model=models.TrackedShapeAttributeVal,
            objects=db_shape_attrvals,
            flt_param={}
        )

        shape_idx = 0
        for track, db_track in zip(tracks, db_tracks):
            track["id"] = db_track.id
            for shape in track["shapes"]:
                shape["id"] = db_shapes[shape_idx].id
                shape_idx += 1

        self.ir_data.tracks = tracks

    def _save_shapes_to_db(self, shapes):
        db_shapes = []
        db_attrvals = []

        for shape in shapes:
            attributes = shape.pop("attributes", [])
            # FIXME: need to clamp points (be sure that all of them inside the image)
            # Should we check here or implement a validator?
            db_shape = models.LabeledShape(job=self.db_job, **shape)
            if db_shape.label_id not in self.db_labels:
                raise AttributeError("label_id `{}` is invalid".format(db_shape.label_id))

            for attr in attributes:
                db_attrval = models.LabeledShapeAttributeVal(**attr)
                if db_attrval.spec_id not in self.db_attributes:
                    raise AttributeError("spec_id `{}` is invalid".format(db_attrval.spec_id))
                db_attrval.shape_id = len(db_shapes)
                db_attrvals.append(db_attrval)

            db_shapes.append(db_shape)
            shape["attributes"] = attributes

        db_shapes = bulk_create(
            db_model=models.LabeledShape,
            objects=db_shapes,
            flt_param={"job_id": self.db_job.id}
        )

        for db_attrval in db_attrvals:
            db_attrval.shape_id = db_shapes[db_attrval.shape_id].id

        bulk_create(
            db_model=models.LabeledShapeAttributeVal,
            objects=db_attrvals,
            flt_param={}
        )

        for shape, db_shape in zip(shapes, db_shapes):
            shape["id"] = db_shape.id

        self.ir_data.shapes = shapes

    def _save_tags_to_db(self, tags):
        db_tags = []
        db_attrvals = []

        for tag in tags:
            attributes = tag.pop("attributes", [])
            db_tag = models.LabeledImage(job=self.db_job, **tag)
            if db_tag.label_id not in self.db_labels:
                raise AttributeError("label_id `{}` is invalid".format(db_tag.label_id))

            for attr in attributes:
                db_attrval = models.LabeledImageAttributeVal(**attr)
                if db_attrval.spec_id not in self.db_attributes:
                    raise AttributeError("spec_id `{}` is invalid".format(db_attrval.spec_id))
                db_attrval.tag_id = len(db_tags)
                db_attrvals.append(db_attrval)

            db_tags.append(db_tag)
            tag["attributes"] = attributes

        db_tags = bulk_create(
            db_model=models.LabeledImage,
            objects=db_tags,
            flt_param={"job_id": self.db_job.id}
        )

        for db_attrval in db_attrvals:
            db_attrval.tag_id = db_tags[db_attrval.tag_id].id

        bulk_create(
            db_model=models.LabeledImageAttributeVal,
            objects=db_attrvals,
            flt_param={}
        )

        for tag, db_tag in zip(tags, db_tags):
            tag["id"] = db_tag.id

        self.ir_data.tags = tags

    def _commit(self):
        db_prev_commit = self.db_job.commits.last()
        db_curr_commit = models.JobCommit()
        if db_prev_commit:
            db_curr_commit.version = db_prev_commit.version + 1
        else:
            db_curr_commit.version = 1
        db_curr_commit.job = self.db_job
        db_curr_commit.message = "Changes: tags - {}; shapes - {}; tracks - {}".format(
            len(self.ir_data.tags), len(self.ir_data.shapes), len(self.ir_data.tracks))
        db_curr_commit.save()
        self.ir_data.version = db_curr_commit.version

    def _save_to_db(self, data):
        self.reset()
        self._save_tags_to_db(data["tags"])
        self._save_shapes_to_db(data["shapes"])
        self._save_tracks_to_db(data["tracks"])

        return self.ir_data.tags or self.ir_data.shapes or self.ir_data.tracks

    def _create(self, data):
        if self._save_to_db(data):
            db_task = self.db_job.segment.task
            db_task.updated_date = timezone.now()
            db_task.save()
            self.db_job.save()

    def create(self, data):
        self._create(data)
        self._commit()

    def put(self, data):
        self._delete()
        self._create(data)
        self._commit()

    def update(self, data):
        self._delete(data)
        self._create(data)
        self._commit()

    def _delete(self, data=None):
        if data is None:
            self.db_job.labeledimage_set.all().delete()
            self.db_job.labeledshape_set.all().delete()
            self.db_job.labeledtrack_set.all().delete()
        else:
            labeledimage_ids = [image["id"] for image in data["tags"]]
            labeledshape_ids = [shape["id"] for shape in data["shapes"]]
            labeledtrack_ids = [track["id"] for track in data["tracks"]]
            labeledimage_set = self.db_job.labeledimage_set
            labeledimage_set = labeledimage_set.filter(pk__in=labeledimage_ids)
            labeledshape_set = self.db_job.labeledshape_set
            labeledshape_set = labeledshape_set.filter(pk__in=labeledshape_ids)
            labeledtrack_set = self.db_job.labeledtrack_set
            labeledtrack_set = labeledtrack_set.filter(pk__in=labeledtrack_ids)

            # It is not important for us that data had some "invalid" objects
            # which were skipped (not acutally deleted). The main idea is to
            # say that all requested objects are absent in DB after the method.
            self.ir_data.tags = data['tags']
            self.ir_data.shapes = data['shapes']
            self.ir_data.tracks = data['tracks']

            labeledimage_set.delete()
            labeledshape_set.delete()
            labeledtrack_set.delete()

    def delete(self, data=None):
        self._delete(data)
        self._commit()

    def _init_tags_from_db(self):
        db_tags = self.db_job.labeledimage_set.prefetch_related(
            "label",
            "labeledimageattributeval_set"
        ).values(
            'id',
            'frame',
            'label_id',
            'group',
            'labeledimageattributeval__spec_id',
            'labeledimageattributeval__value',
            'labeledimageattributeval__id',
        ).order_by('frame')

        db_tags = _merge_table_rows(
            rows=db_tags,
            keys_for_merge={
                "labeledimageattributeval_set": [
                    'labeledimageattributeval__spec_id',
                    'labeledimageattributeval__value',
                    'labeledimageattributeval__id',
                ],
            },
            field_id='id',
        )
        serializer = serializers.LabeledImageSerializer(db_tags, many=True)
        self.ir_data.tags = serializer.data

    def _init_shapes_from_db(self):
        db_shapes = self.db_job.labeledshape_set.prefetch_related(
            "label",
            "labeledshapeattributeval_set"
        ).values(
            'id',
            'label_id',
            'type',
            'frame',
            'group',
            'occluded',
            'z_order',
            'points',
            'labeledshapeattributeval__spec_id',
            'labeledshapeattributeval__value',
            'labeledshapeattributeval__id',
            ).order_by('frame')

        db_shapes = _merge_table_rows(
            rows=db_shapes,
            keys_for_merge={
                'labeledshapeattributeval_set': [
                    'labeledshapeattributeval__spec_id',
                    'labeledshapeattributeval__value',
                    'labeledshapeattributeval__id',
                ],
            },
            field_id='id',
        )

        serializer = serializers.LabeledShapeSerializer(db_shapes, many=True)
        self.ir_data.shapes = serializer.data

    def _init_tracks_from_db(self):
        db_tracks = self.db_job.labeledtrack_set.prefetch_related(
            "label",
            "labeledtrackattributeval_set",
            "trackedshape_set__trackedshapeattributeval_set"
        ).values(
            "id",
            "frame",
            "label_id",
            "group",
            "labeledtrackattributeval__spec_id",
            "labeledtrackattributeval__value",
            "labeledtrackattributeval__id",
            "trackedshape__type",
            "trackedshape__occluded",
            "trackedshape__z_order",
            "trackedshape__points",
            "trackedshape__id",
            "trackedshape__frame",
            "trackedshape__outside",
            "trackedshape__trackedshapeattributeval__spec_id",
            "trackedshape__trackedshapeattributeval__value",
            "trackedshape__trackedshapeattributeval__id",
        ).order_by('id', 'trackedshape__frame')

        db_tracks = _merge_table_rows(
            rows=db_tracks,
            keys_for_merge={
                "labeledtrackattributeval_set": [
                    "labeledtrackattributeval__spec_id",
                    "labeledtrackattributeval__value",
                    "labeledtrackattributeval__id",
                ],
                "trackedshape_set":[
                    "trackedshape__type",
                    "trackedshape__occluded",
                    "trackedshape__z_order",
                    "trackedshape__points",
                    "trackedshape__id",
                    "trackedshape__frame",
                    "trackedshape__outside",
                    "trackedshape__trackedshapeattributeval__spec_id",
                    "trackedshape__trackedshapeattributeval__value",
                    "trackedshape__trackedshapeattributeval__id",
                ],
            },
            field_id="id",
        )

        for db_track in db_tracks:
            db_track["trackedshape_set"] = _merge_table_rows(db_track["trackedshape_set"], {
                'trackedshapeattributeval_set': [
                    'trackedshapeattributeval__value',
                    'trackedshapeattributeval__spec_id',
                    'trackedshapeattributeval__id',
                ]
            }, 'id')

            # A result table can consist many equal rows for track/shape attributes
            # We need filter unique attributes manually
            db_track["labeledtrackattributeval_set"] = list(set(db_track["labeledtrackattributeval_set"]))
            for db_shape in db_track["trackedshape_set"]:
                db_shape["trackedshapeattributeval_set"] = list(
                    set(db_shape["trackedshapeattributeval_set"])
                )

        serializer = serializers.LabeledTrackSerializer(db_tracks, many=True)
        self.ir_data.tracks = serializer.data

    def _init_version_from_db(self):
        db_commit = self.db_job.commits.last()
        self.ir_data.version = db_commit.version if db_commit else 0

    def init_from_db(self):
        self._init_tags_from_db()
        self._init_shapes_from_db()
        self._init_tracks_from_db()
        self._init_version_from_db()

    @property
    def data(self):
        return self.ir_data.data

    def upload(self, annotation_file, loader):
        annotation_importer = Annotation(
            annotation_ir=self.ir_data,
            db_task=self.db_job.segment.task,
            create_callback=self.create,
            )
        self.delete()
        db_format = loader.annotation_format
        with open(annotation_file, 'rb') as file_object:
            source_code = open(os.path.join(settings.BASE_DIR, db_format.handler_file.name)).read()
            global_vars = globals()
            imports = import_modules(source_code)
            global_vars.update(imports)
            exec(source_code, global_vars)

            global_vars["file_object"] = file_object
            global_vars["annotations"] = annotation_importer

            exec("{}(file_object, annotations)".format(loader.handler), global_vars)
        self.create(annotation_importer.data.slice(self.start_frame, self.stop_frame).serialize())

class TaskAnnotation:
    def __init__(self, pk, user):
        self.user = user
        self.db_task = models.Task.objects.prefetch_related("image_set").get(id=pk)
        self.db_jobs = models.Job.objects.select_related("segment").filter(segment__task_id=pk)
        self.ir_data = AnnotationIR()

    def reset(self):
        self.ir_data.reset()

    def _patch_data(self, data, action):
        _data = data if isinstance(data, AnnotationIR) else AnnotationIR(data)
        splitted_data = {}
        jobs = {}
        for db_job in self.db_jobs:
            jid = db_job.id
            start = db_job.segment.start_frame
            stop = db_job.segment.stop_frame
            jobs[jid] = { "start": start, "stop": stop }
            splitted_data[jid] = _data.slice(start, stop)

        for jid, job_data in splitted_data.items():
            _data = AnnotationIR()
            if action is None:
                _data.data = put_job_data(jid, self.user, job_data)
            else:
                _data.data = patch_job_data(jid, self.user, job_data, action)
            if _data.version > self.ir_data.version:
                self.ir_data.version = _data.version
            self._merge_data(_data, jobs[jid]["start"], self.db_task.overlap)

    def _merge_data(self, data, start_frame, overlap):
        data_manager = DataManager(self.ir_data)
        data_manager.merge(data, start_frame, overlap)

    def put(self, data):
        self._patch_data(data, None)

    def create(self, data):
        self._patch_data(data, PatchAction.CREATE)

    def update(self, data):
        self._patch_data(data, PatchAction.UPDATE)

    def delete(self, data=None):
        if data:
            self._patch_data(data, PatchAction.DELETE)
        else:
            for db_job in self.db_jobs:
                delete_job_data(db_job.id, self.user)

    def init_from_db(self):
        self.reset()

        for db_job in self.db_jobs:
            annotation = JobAnnotation(db_job.id, self.user)
            annotation.init_from_db()
            if annotation.ir_data.version > self.ir_data.version:
                self.ir_data.version = annotation.ir_data.version
            db_segment = db_job.segment
            start_frame = db_segment.start_frame
            overlap = self.db_task.overlap
            self._merge_data(annotation.ir_data, start_frame, overlap)

    def dump(self, filename, dumper, scheme, host):
        anno_exporter = Annotation(
            annotation_ir=self.ir_data,
            db_task=self.db_task,
            scheme=scheme,
            host=host,
        )
        db_format = dumper.annotation_format

        with open(filename, 'wb') as dump_file:
            source_code = open(os.path.join(settings.BASE_DIR, db_format.handler_file.name)).read()
            global_vars = globals()
            imports = import_modules(source_code)
            global_vars.update(imports)
            exec(source_code, global_vars)
            global_vars["file_object"] = dump_file
            global_vars["annotations"] = anno_exporter

            exec("{}(file_object, annotations)".format(dumper.handler), global_vars)

    def upload(self, annotation_file, loader):
        annotation_importer = Annotation(
            annotation_ir=AnnotationIR(),
            db_task=self.db_task,
            create_callback=self.create,
            )
        self.delete()
        db_format = loader.annotation_format
        with open(annotation_file, 'rb') as file_object:
            source_code = open(os.path.join(settings.BASE_DIR, db_format.handler_file.name)).read()
            global_vars = globals()
            imports = import_modules(source_code)
            global_vars.update(imports)
            exec(source_code, global_vars)

            global_vars["file_object"] = file_object
            global_vars["annotations"] = annotation_importer

            exec("{}(file_object, annotations)".format(loader.handler), global_vars)
        self.create(annotation_importer.data.serialize())

    @property
    def data(self):
        return self.ir_data.data
