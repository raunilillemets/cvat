/*
 * Copyright (C) 2018 Intel Corporation
 *
 * SPDX-License-Identifier: MIT
 */

/* exported PlayerModel PlayerController PlayerView */

/* global
    blurAllElements:false
    copyToClipboard:false
    Listener:false
    Logger:false
    Mousetrap:false
*/

'use strict';

class FrameProvider extends Listener {
    constructor(stop, tid) {
        super('onFrameLoad', () => this._loaded);
        this._MAX_LOAD = 500;

        this._stack = [];
        this._loadInterval = null;
        this._required = null;
        this._loaded = null;
        this._loadAllowed = true;
        this._preloadRunned = false;
        this._loadCounter = this._MAX_LOAD;
        this._frameCollection = {};
        this._stop = stop;
        this._tid = tid;
    }

    require(frame) {
        if (frame in this._frameCollection) {
            this._preload(frame);
            return this._frameCollection[frame];
        }
        this._required = frame;
        this._loadCounter = this._MAX_LOAD;
        this._load();
        return null;
    }

    _onImageLoad(image, frame) {
        const next = frame + 1;
        if (next <= this._stop && this._loadCounter > 0) {
            this._stack.push(next);
        }
        this._loadCounter--;
        this._loaded = frame;
        this._frameCollection[frame] = image;
        this._loadAllowed = true;
        image.onload = null;
        image.onerror = null;
        this.notify();
    }

    _preload(frame) {
        if (this._preloadRunned) {
            return;
        }

        const last = Math.min(this._stop, frame + Math.ceil(this._MAX_LOAD / 2));
        if (!(last in this._frameCollection)) {
            for (let idx = frame + 1; idx <= last; idx++) {
                if (!(idx in this._frameCollection)) {
                    this._loadCounter = this._MAX_LOAD - (idx - frame);
                    this._stack.push(idx);
                    this._preloadRunned = true;
                    this._load();
                    return;
                }
            }
        }
    }

    _load() {
        if (!this._loadInterval) {
            this._loadInterval = setInterval(() => {
                if (!this._loadAllowed) {
                    return;
                }

                if (this._loadCounter <= 0) {
                    this._stack = [];
                }

                if (!this._stack.length && this._required == null) {
                    clearInterval(this._loadInterval);
                    this._preloadRunned = false;
                    this._loadInterval = null;
                    return;
                }

                if (this._required != null) {
                    this._stack.push(this._required);
                    this._required = null;
                }

                const frame = this._stack.pop();
                if (frame in this._frameCollection) {
                    this._loadCounter--;
                    const next = frame + 1;
                    if (next <= this._stop && this._loadCounter > 0) {
                        this._stack.push(frame + 1);
                    }
                    return;
                }

                // If load up to last frame, no need to load previous frames from stack
                if (frame === this._stop) {
                    this._stack = [];
                }

                this._loadAllowed = false;
                const image = new Image();
                image.onload = this._onImageLoad.bind(this, image, frame);
                image.onerror = () => {
                    this._loadAllowed = true;
                    image.onload = null;
                    image.onerror = null;
                };
                image.src = `/api/v1/tasks/${this._tid}/frames/${frame}`;
            }, 25);
        }
    }
}


const MAX_PLAYER_SCALE = 10;
const MIN_PLAYER_SCALE = 0.1;

class PlayerModel extends Listener {
    constructor(task, playerSize) {
        super('onPlayerUpdate', () => this);
        this._frame = {
            start: window.cvat.player.frames.start,
            stop: window.cvat.player.frames.stop,
            current: window.cvat.player.frames.current,
            previous: null,
        };

        this._settings = {
            multipleStep: 10,
            fps: 25,
            rotateAll: task.mode === 'interpolation',
            resetZoom: task.mode === 'annotation',
        };

        this._playInterval = null;
        this._pauseFlag = null;
        this._frameProvider = new FrameProvider(this._frame.stop, task.id);
        this._continueAfterLoad = false;
        this._continueTimeout = null;

        this._geometry = {
            scale: 1,
            left: 0,
            top: 0,
            width: playerSize.width,
            height: playerSize.height,
            frameOffset: 0,
            rotation: 0,
        };
        this._framewiseRotation = {};
        const frameOffset = Math.max((playerSize.height - MIN_PLAYER_SCALE) / MIN_PLAYER_SCALE,
            (playerSize.width - MIN_PLAYER_SCALE) / MIN_PLAYER_SCALE);
        this._geometry.frameOffset = Math.floor(frameOffset);
        window.cvat.translate.playerOffset = this._geometry.frameOffset;
        window.cvat.player.rotation = this._geometry.rotation;

        this._frameProvider.subscribe(this);
    }

    get frames() {
        return {
            start: this._frame.start,
            stop: this._frame.stop,
            current: this._frame.current,
            previous: this._frame.previous,
        };
    }

    get geometry() {
        const copy = Object.assign({}, this._geometry);
        copy.rotation = this._settings.rotateAll ? this._geometry.rotation
            : this._framewiseRotation[this._frame.current] || 0;
        return copy;
    }

    get playing() {
        return this._playInterval != null;
    }

    get image() {
        return this._frameProvider.require(this._frame.current);
    }

    get resetZoom() {
        return this._settings.resetZoom;
    }

    get multipleStep() {
        return this._settings.multipleStep;
    }

    get rotateAll() {
        return this._settings.rotateAll;
    }

    set rotateAll(value) {
        this._settings.rotateAll = value;

        if (!value) {
            this._geometry.rotation = 0;
        } else {
            this._framewiseRotation = {};
        }

        this.fit();
    }

    set fps(value) {
        this._settings.fps = value;
    }

    set multipleStep(value) {
        this._settings.multipleStep = value;
    }

    set resetZoom(value) {
        this._settings.resetZoom = value;
    }

    ready() {
        return this._frame.previous === this._frame.current;
    }

    onFrameLoad(last) { // callback for FrameProvider instance
        if (last === this._frame.current) {
            if (this._continueTimeout) {
                clearTimeout(this._continueTimeout);
                this._continueTimeout = null;
            }

            // If need continue playing after load, set timeout for additional frame download
            if (this._continueAfterLoad) {
                this._continueTimeout = setTimeout(() => {
                    // If you still need to play, start it
                    this._continueTimeout = null;
                    if (this._continueAfterLoad) {
                        this._continueAfterLoad = false;
                        this.play();
                    } else { // Else update the frame
                        this.shift(0);
                    }
                }, 5000);
            } else { // Just update frame if no need to play
                this.shift(0);
            }
        }
    }

    play() {
        this._pauseFlag = false;
        this._playInterval = setInterval(() => {
            if (this._pauseFlag) { // pause method without notify (for frame downloading)
                if (this._playInterval) {
                    clearInterval(this._playInterval);
                    this._playInterval = null;
                }
                return;
            }

            const skip = Math.max(Math.floor(this._settings.fps / 25), 1);
            if (!this.shift(skip)) this.pause(); // if not changed, pause
        }, 1000 / this._settings.fps);
    }

    pause() {
        if (this._playInterval) {
            clearInterval(this._playInterval);
            this._playInterval = null;
            this._pauseFlag = true;
            this.notify();
        }
    }

    updateGeometry(geometry) {
        this._geometry.width = geometry.width;
        this._geometry.height = geometry.height;
    }

    shift(delta, absolute) {
        if (['resize', 'drag'].indexOf(window.cvat.mode) !== -1) {
            return false;
        }

        this._continueAfterLoad = false; // default reset continue
        this._frame.current = Math.clamp(absolute ? delta : this._frame.current + delta,
            this._frame.start,
            this._frame.stop);
        const frame = this._frameProvider.require(this._frame.current);
        if (!frame) {
            this._continueAfterLoad = this.playing;
            this._pauseFlag = true;
            this.notify();
            return false;
        }

        window.cvat.player.frames.current = this._frame.current;
        window.cvat.player.geometry.frameWidth = frame.width;
        window.cvat.player.geometry.frameHeight = frame.height;

        Logger.addEvent(Logger.EventType.changeFrame, {
            from: this._frame.previous,
            to: this._frame.current,
        });

        const changed = this._frame.previous !== this._frame.current;
        const curFrameRotation = this._framewiseRotation[this._frame.current];
        const prevFrameRotation = this._framewiseRotation[this._frame.previous];
        const differentRotation = curFrameRotation !== prevFrameRotation;
        // fit if tool is in the annotation mode or frame loading is first in the interpolation mode
        if (this._settings.resetZoom || this._frame.previous === null || differentRotation) {
            this._frame.previous = this._frame.current;
            this.fit(); // notify() inside the fit()
        } else {
            this._frame.previous = this._frame.current;
            this.notify();
        }

        return changed;
    }

    fit() {
        const img = this._frameProvider.require(this._frame.current);
        if (!img) return;

        const { rotation } = this.geometry;

        if ((rotation / 90) % 2) {
            // 90, 270, ..
            this._geometry.scale = Math.min(this._geometry.width / img.height,
                this._geometry.height / img.width);
        } else {
            // 0, 180, ..
            this._geometry.scale = Math.min(this._geometry.width / img.width,
                this._geometry.height / img.height);
        }

        this._geometry.top = (this._geometry.height - img.height * this._geometry.scale) / 2;
        this._geometry.left = (this._geometry.width - img.width * this._geometry.scale) / 2;

        window.cvat.player.rotation = rotation;
        window.cvat.player.geometry.scale = this._geometry.scale;
        this.notify();
    }

    focus(xtl, xbr, ytl, ybr) {
        const img = this._frameProvider.require(this._frame.current);
        if (!img) return;
        const fittedScale = Math.min(this._geometry.width / img.width,
            this._geometry.height / img.height);

        const boxWidth = xbr - xtl;
        const boxHeight = ybr - ytl;
        const wScale = this._geometry.width / boxWidth;
        const hScale = this._geometry.height / boxHeight;
        this._geometry.scale = Math.min(wScale, hScale);
        this._geometry.scale = Math.min(this._geometry.scale, MAX_PLAYER_SCALE);
        this._geometry.scale = Math.max(this._geometry.scale, MIN_PLAYER_SCALE);

        if (this._geometry.scale < fittedScale) {
            this._geometry.scale = fittedScale;
            this._geometry.top = (this._geometry.height - img.height * this._geometry.scale) / 2;
            this._geometry.left = (this._geometry.width - img.width * this._geometry.scale) / 2;
        } else {
            this._geometry.left = (this._geometry.width / this._geometry.scale - xtl * 2 - boxWidth) * this._geometry.scale / 2;
            this._geometry.top = (this._geometry.height / this._geometry.scale - ytl * 2 - boxHeight) * this._geometry.scale / 2;
        }
        window.cvat.player.geometry.scale = this._geometry.scale;
        this._frame.previous = this._frame.current; // fix infinite loop via playerUpdate->collectionUpdate*->AAMUpdate->playerUpdate->...
        this.notify();
    }

    scale(point, value) {
        if (!this._frameProvider.require(this._frame.current)) return;

        const oldScale = this._geometry.scale;
        const newScale = value > 0 ? this._geometry.scale * 6 / 5 : this._geometry.scale * 5 / 6;
        this._geometry.scale = Math.clamp(newScale, MIN_PLAYER_SCALE, MAX_PLAYER_SCALE);

        this._geometry.left += (point.x * (oldScale / this._geometry.scale - 1)) * this._geometry.scale;
        this._geometry.top += (point.y * (oldScale / this._geometry.scale - 1)) * this._geometry.scale;

        window.cvat.player.geometry.scale = this._geometry.scale;
        this.notify();
    }

    move(topOffset, leftOffset) {
        this._geometry.top += topOffset;
        this._geometry.left += leftOffset;
        this.notify();
    }

    rotate(angle) {
        if (['resize', 'drag'].indexOf(window.cvat.mode) !== -1) {
            return false;
        }

        if (this._settings.rotateAll) {
            this._geometry.rotation += angle;
            this._geometry.rotation %= 360;
        } else if (typeof (this._framewiseRotation[this._frame.current]) === 'undefined') {
            this._framewiseRotation[this._frame.current] = angle;
        } else {
            this._framewiseRotation[this._frame.current] += angle;
            this._framewiseRotation[this._frame.current] %= 360;
        }

        this.fit();
    }
}


class PlayerController {
    constructor(playerModel, activeTrack, find, playerOffset) {
        this._model = playerModel;
        this._find = find;
        this._rewinding = false;
        this._moving = false;
        this._leftOffset = playerOffset.left;
        this._topOffset = playerOffset.top;
        this._lastClickX = 0;
        this._lastClickY = 0;
        this._moveFrameEvent = null;
        this._events = {
            jump: null,
            move: null,
        };

        function setupPlayerShortcuts(playerModel) {
            const nextHandler = Logger.shortkeyLogDecorator((e) => {
                this.next();
                e.preventDefault();
            });

            const prevHandler = Logger.shortkeyLogDecorator((e) => {
                this.previous();
                e.preventDefault();
            });

            const nextKeyFrameHandler = Logger.shortkeyLogDecorator(() => {
                const active = activeTrack();
                if (active && active.type.split('_')[0] === 'interpolation') {
                    const nextKeyFrame = active.nextKeyFrame();
                    if (nextKeyFrame != null) {
                        this._model.shift(nextKeyFrame, true);
                    }
                }
            });

            const prevKeyFrameHandler = Logger.shortkeyLogDecorator(() => {
                const active = activeTrack();
                if (active && active.type.split('_')[0] === 'interpolation') {
                    const prevKeyFrame = active.prevKeyFrame();
                    if (prevKeyFrame != null) {
                        this._model.shift(prevKeyFrame, true);
                    }
                }
            });


            const nextFilterFrameHandler = Logger.shortkeyLogDecorator((e) => {
                const frame = this._find(1);
                if (frame != null) {
                    this._model.shift(frame, true);
                }
                e.preventDefault();
            });

            const prevFilterFrameHandler = Logger.shortkeyLogDecorator((e) => {
                const frame = this._find(-1);
                if (frame != null) {
                    this._model.shift(frame, true);
                }
                e.preventDefault();
            });


            const forwardHandler = Logger.shortkeyLogDecorator(() => {
                this.forward();
            });

            const backwardHandler = Logger.shortkeyLogDecorator(() => {
                this.backward();
            });

            const playPauseHandler = Logger.shortkeyLogDecorator(() => {
                if (playerModel.playing) {
                    this.pause();
                } else {
                    this.play();
                }
                return false;
            });

            const fitHandler = Logger.shortkeyLogDecorator(() => {
                this.fit();
            });

            const { shortkeys } = window.cvat.config;

            Mousetrap.bind('.', fitHandler, 'keydown');
            Mousetrap.bind(shortkeys.next_frame.value, nextHandler, 'keydown');
            Mousetrap.bind(shortkeys.prev_frame.value, prevHandler, 'keydown');
            Mousetrap.bind(shortkeys.next_filter_frame.value, nextFilterFrameHandler, 'keydown');
            Mousetrap.bind(shortkeys.prev_filter_frame.value, prevFilterFrameHandler, 'keydown');
            Mousetrap.bind(shortkeys.next_key_frame.value, nextKeyFrameHandler, 'keydown');
            Mousetrap.bind(shortkeys.prev_key_frame.value, prevKeyFrameHandler, 'keydown');
            Mousetrap.bind(shortkeys.forward_frame.value, forwardHandler, 'keydown');
            Mousetrap.bind(shortkeys.backward_frame.value, backwardHandler, 'keydown');
            Mousetrap.bind(shortkeys.play_pause.value, playPauseHandler, 'keydown');
            Mousetrap.bind(shortkeys.clockwise_rotation.value, (e) => {
                e.preventDefault();
                this.rotate(90);
            }, 'keydown');
            Mousetrap.bind(shortkeys.counter_clockwise_rotation.value, (e) => {
                e.preventDefault();
                this.rotate(-90);
            }, 'keydown');
        }

        setupPlayerShortcuts.call(this, playerModel);
    }

    zoomToFour(e, canvas) {
        //experiments showed that 4th zoom level is at zoom 0.83106. 
        //since this value might chance from computer to computer, we allow for ~10% error
        //in order to avoid infinite loops
        const zoomFourLowBorder = 0.75864;
        const zoomFourHighBorder = 0.9104;

        const point = window.cvat.translate.point.clientToCanvas(canvas, e.clientX, e.clientY);

        var done = false;
        while(!done) {
            if(this._model.geometry.scale < zoomFourLowBorder) {
                this._model.scale(point, 1);
            } else if(this._model.geometry.scale > zoomFourHighBorder) {
                this._model.scale(point, -1);
            } else {
                done = true;
            }
        }
        
        e.preventDefault();
    }

    zoom(e, canvas) {
        const point = window.cvat.translate.point.clientToCanvas(canvas, e.clientX, e.clientY);

        const zoomImageEvent = Logger.addContinuedEvent(Logger.EventType.zoomImage);

        if (e.originalEvent.deltaY < 0) {
            this._model.scale(point, 1);
        } else {
            this._model.scale(point, -1);
        }
        zoomImageEvent.close();
        e.preventDefault();
    }

    fit() {
        Logger.addEvent(Logger.EventType.fitImage);
        this._model.fit();
    }

    frameMouseDown(e) {
        if ((e.which === 1 && !window.cvat.mode) || (e.which === 2)) {
            this._moving = true;

            const p = window.cvat.translate.point.rotate(e.clientX, e.clientY);

            this._lastClickX = p.x;
            this._lastClickY = p.y;
        }
    }

    frameMouseUp() {
        this._moving = false;
        if (this._events.move) {
            this._events.move.close();
            this._events.move = null;
        }
    }

    frameMouseMove(e) {
        if (this._moving) {
            if (!this._events.move) {
                this._events.move = Logger.addContinuedEvent(Logger.EventType.moveImage);
            }

            const p = window.cvat.translate.point.rotate(e.clientX, e.clientY);
            const topOffset = p.y - this._lastClickY;
            const leftOffset = p.x - this._lastClickX;
            this._lastClickX = p.x;
            this._lastClickY = p.y;
            this._model.move(topOffset, leftOffset);
        }
    }

    progressMouseDown(e) {
        this._rewinding = true;
        this._rewind(e);
    }

    progressMouseUp() {
        this._rewinding = false;
        if (this._events.jump) {
            this._events.jump.close();
            this._events.jump = null;
        }
    }

    progressMouseMove(e) {
        this._rewind(e);
    }

    _rewind(e) {
        if (this._rewinding) {
            if (!this._events.jump) {
                this._events.jump = Logger.addContinuedEvent(Logger.EventType.jumpFrame);
            }

            const { frames } = this._model;
            const progressWidth = e.target.clientWidth;
            const x = e.clientX + window.pageXOffset - e.target.offsetLeft;
            const percent = x / progressWidth;
            const targetFrame = Math.round((frames.stop - frames.start) * percent);
            this._model.pause();
            this._model.shift(targetFrame + frames.start, true);
        }
    }

    changeStep(e) {
        const value = Math.clamp(+e.target.value, +e.target.min, +e.target.max);
        e.target.value = value;
        this._model.multipleStep = value;
    }

    changeFPS(e) {
        const fpsMap = {
            1: 1,
            2: 5,
            3: 12,
            4: 25,
            5: 50,
            6: 100,
        };
        const value = Math.clamp(+e.target.value, 1, 6);
        this._model.fps = fpsMap[value];
    }

    changeResetZoom(e) {
        this._model.resetZoom = e.target.checked;
    }

    play() {
        this._model.play();
    }

    pause() {
        this._model.pause();
    }

    next() {
        this._model.shift(1);
        this._model.pause();
    }

    previous() {
        this._model.shift(-1);
        this._model.pause();
    }

    first() {
        this._model.shift(this._model.frames.start, true);
        this._model.pause();
    }

    last() {
        this._model.shift(this._model.frames.stop, true);
        this._model.pause();
    }

    forward() {
        this._model.shift(this._model.multipleStep);
        this._model.pause();
    }

    backward() {
        this._model.shift(-this._model.multipleStep);
        this._model.pause();
    }

    seek(frame) {
        this._model.shift(frame, true);
    }

    rotate(angle) {
        Logger.addEvent(Logger.EventType.rotateImage);
        this._model.rotate(angle);
    }

    get rotateAll() {
        return this._model.rotateAll;
    }

    set rotateAll(value) {
        this._model.rotateAll = value;
    }
}


class PlayerView {
    constructor(playerModel, playerController) {
        this._controller = playerController;
        this._playerUI = $('#playerFrame');
        this._playerBackgroundUI = $('#frameBackground');
        this._playerContentUI = $('#frameContent');
        this._playerGridUI = $('#frameGrid');
        this._playerTextUI = $('#frameText');
        this._progressUI = $('#playerProgress');
        this._loadingUI = $('#frameLoadingAnim');
        this._playButtonUI = $('#playButton');
        this._pauseButtonUI = $('#pauseButton');
        this._nextButtonUI = $('#nextButton');
        this._prevButtonUI = $('#prevButton');
        this._multipleNextButtonUI = $('#multipleNextButton');
        this._multiplePrevButtonUI = $('#multiplePrevButton');
        this._firstButtonUI = $('#firstButton');
        this._lastButtonUI = $('#lastButton');
        this._playerStepUI = $('#playerStep');
        this._playerSpeedUI = $('#speedSelect');
        this._resetZoomUI = $('#resetZoomBox');
        this._frameNumber = $('#frameNumber');
        this._playerGridPattern = $('#playerGridPattern');
        this._playerGridPath = $('#playerGridPath');
        this._contextMenuUI = $('#playerContextMenu');
        this._clockwiseRotationButtonUI = $('#clockwiseRotation');
        this._counterClockwiseRotationButtonUI = $('#counterClockwiseRotation');
        this._rotationWrapperUI = $('#rotationWrapper');
        this._rotatateAllImagesUI = $('#rotateAllImages');

        this._clockwiseRotationButtonUI.on('click', () => {
            this._controller.rotate(90);
        });

        this._counterClockwiseRotationButtonUI.on('click', () => {
            this._controller.rotate(-90);
        });

        this._rotatateAllImagesUI.prop('checked', this._controller.rotateAll);
        this._rotatateAllImagesUI.on('change', (e) => {
            this._controller.rotateAll = e.target.checked;
        });

        $('*').on('mouseup.player', () => this._controller.frameMouseUp());
        this._playerContentUI.on('mousedown', (e) => {
            const pos = window.cvat.translate.point.clientToCanvas(this._playerBackgroundUI[0],
                e.clientX, e.clientY);
            const { frameWidth } = window.cvat.player.geometry;
            const { frameHeight } = window.cvat.player.geometry;
            if (pos.x >= 0 && pos.y >= 0 && pos.x <= frameWidth && pos.y <= frameHeight) {
                this._controller.frameMouseDown(e);
            }
            e.preventDefault();
        });

        this._playerContentUI.on('wheel', e => this._controller.zoom(e, this._playerBackgroundUI[0]));
        this._playerContentUI.on('dblclick', e => this._controller.zoomToFour(e, this._playerBackgroundUI[0]));
        this._playerContentUI.on('mousemove', e => this._controller.frameMouseMove(e));
        this._progressUI.on('mousedown', e => this._controller.progressMouseDown(e));
        this._progressUI.on('mouseup', () => this._controller.progressMouseUp());
        this._progressUI.on('mousemove', e => this._controller.progressMouseMove(e));
        this._playButtonUI.on('click', () => this._controller.play());
        this._pauseButtonUI.on('click', () => this._controller.pause());
        this._nextButtonUI.on('click', () => this._controller.next());
        this._prevButtonUI.on('click', () => this._controller.previous());
        this._multipleNextButtonUI.on('click', () => this._controller.forward());
        this._multiplePrevButtonUI.on('click', () => this._controller.backward());
        this._firstButtonUI.on('click', () => this._controller.first());
        this._lastButtonUI.on('click', () => this._controller.last());
        this._playerSpeedUI.on('change', e => this._controller.changeFPS(e));
        this._resetZoomUI.on('change', e => this._controller.changeResetZoom(e));
        this._playerStepUI.on('change', e => this._controller.changeStep(e));
        this._frameNumber.on('change', (e) => {
            if (Number.isInteger(+e.target.value)) {
                this._controller.seek(+e.target.value);
                blurAllElements();
            }
        });

        const { shortkeys } = window.cvat.config;

        this._clockwiseRotationButtonUI.attr('title', `
            ${shortkeys.clockwise_rotation.view_value} - ${shortkeys.clockwise_rotation.description}`);
        this._counterClockwiseRotationButtonUI.attr('title', `
            ${shortkeys.counter_clockwise_rotation.view_value} - ${shortkeys.counter_clockwise_rotation.description}`);

        const playerGridOpacityInput = $('#playerGridOpacityInput');
        playerGridOpacityInput.on('input', (e) => {
            const value = Math.clamp(+e.target.value, +e.target.min, +e.target.max);
            e.target.value = value;
            this._playerGridPath.attr({
                opacity: value / +e.target.max,
            });
        });

        playerGridOpacityInput.attr('title', `
            ${shortkeys.change_grid_opacity.view_value} - ${shortkeys.change_grid_opacity.description}`);

        const playerGridStrokeInput = $('#playerGridStrokeInput');
        playerGridStrokeInput.on('change', (e) => {
            this._playerGridPath.attr({
                stroke: e.target.value,
            });
        });

        playerGridStrokeInput.attr('title', `
            ${shortkeys.change_grid_color.view_value} - ${shortkeys.change_grid_color.description}`);

        $('#playerGridSizeInput').on('change', (e) => {
            const value = Math.clamp(+e.target.value, +e.target.min, +e.target.max);
            e.target.value = value;
            this._playerGridPattern.attr({
                width: value,
                height: value,
            });
        });

        Mousetrap.bind(shortkeys.focus_to_frame.value, () => this._frameNumber.focus(), 'keydown');
        Mousetrap.bind(shortkeys.change_grid_opacity.value,
            Logger.shortkeyLogDecorator((e) => {
                const ui = playerGridOpacityInput;
                let value = +ui.prop('value');
                value += e.key === '=' ? 1 : -1;
                value = Math.clamp(value, 0, 5);
                ui.prop('value', value);
                this._playerGridPath.attr({
                    opacity: value / +ui.prop('max'),
                });
            }),
            'keydown');

        Mousetrap.bind(shortkeys.change_grid_color.value,
            Logger.shortkeyLogDecorator(() => {
                const ui = playerGridStrokeInput;
                const colors = [];
                for (const opt of ui.find('option')) {
                    colors.push(opt.value);
                }
                const idx = colors.indexOf(this._playerGridPath.attr('stroke')) + 1;
                const value = colors[idx] || colors[0];
                this._playerGridPath.attr('stroke', value);
                ui.prop('value', value);
            }),
            'keydown');

        this._progressUI['0'].max = playerModel.frames.stop - playerModel.frames.start;
        this._progressUI['0'].value = 0;

        this._resetZoomUI.prop('checked', playerModel.resetZoom);
        this._playerStepUI.prop('value', playerModel.multipleStep);
        this._playerSpeedUI.prop('value', '4');

        this._frameNumber.attr('title', `
            ${shortkeys.focus_to_frame.view_value} - ${shortkeys.focus_to_frame.description}`);

        this._nextButtonUI.find('polygon').append($(document.createElementNS('http://www.w3.org/2000/svg', 'title'))
            .html(`${shortkeys.next_frame.view_value} - ${shortkeys.next_frame.description}`));

        this._prevButtonUI.find('polygon').append($(document.createElementNS('http://www.w3.org/2000/svg', 'title'))
            .html(`${shortkeys.prev_frame.view_value} - ${shortkeys.prev_frame.description}`));

        this._playButtonUI.find('polygon').append($(document.createElementNS('http://www.w3.org/2000/svg', 'title'))
            .html(`${shortkeys.play_pause.view_value} - ${shortkeys.play_pause.description}`));

        this._pauseButtonUI.find('polygon').append($(document.createElementNS('http://www.w3.org/2000/svg', 'title'))
            .html(`${shortkeys.play_pause.view_value} - ${shortkeys.play_pause.description}`));

        this._multipleNextButtonUI.find('polygon').append($(document.createElementNS('http://www.w3.org/2000/svg', 'title'))
            .html(`${shortkeys.forward_frame.view_value} - ${shortkeys.forward_frame.description}`));

        this._multiplePrevButtonUI.find('polygon').append($(document.createElementNS('http://www.w3.org/2000/svg', 'title'))
            .html(`${shortkeys.backward_frame.view_value} - ${shortkeys.backward_frame.description}`));


        this._contextMenuUI.click((e) => {
            $('.custom-menu').hide(100);
            switch ($(e.target).attr('action')) {
            case 'job_url': {
                window.cvat.search.set('frame', null);
                window.cvat.search.set('filter', null);
                copyToClipboard(window.cvat.search.toString());
                break;
            }
            case 'frame_url': {
                window.cvat.search.set('frame', window.cvat.player.frames.current);
                window.cvat.search.set('filter', null);
                copyToClipboard(window.cvat.search.toString());
                window.cvat.search.set('frame', null);
                break;
            }
            default:
            }
        });

        this._playerUI.on('contextmenu.playerContextMenu', (e) => {
            if (!window.cvat.mode) {
                $('.custom-menu').hide(100);
                this._contextMenuUI.finish().show(100);
                const x = Math.min(e.pageX, this._playerUI[0].offsetWidth
                    - this._contextMenuUI[0].scrollWidth);
                const y = Math.min(e.pageY, this._playerUI[0].offsetHeight
                    - this._contextMenuUI[0].scrollHeight);
                this._contextMenuUI.offset({
                    left: x,
                    top: y,
                });
                e.preventDefault();
            }
        });

        this._playerContentUI.on('mousedown.playerContextMenu', () => {
            $('.custom-menu').hide(100);
        });

        playerModel.subscribe(this);
    }

    onPlayerUpdate(model) {
        const { image } = model;
        const { frames } = model;
        const { geometry } = model;

        if (!image) {
            this._loadingUI.removeClass('hidden');
            this._playerBackgroundUI.css('background-image', '');
            return;
        }

        this._loadingUI.addClass('hidden');
        if (this._playerBackgroundUI.css('background-image').slice(5, -2) !== image.src) {
            this._playerBackgroundUI.css('background-image', `url("${image.src}")`);
        }

        if (model.playing) {
            this._playButtonUI.addClass('hidden');
            this._pauseButtonUI.removeClass('hidden');
        } else {
            this._pauseButtonUI.addClass('hidden');
            this._playButtonUI.removeClass('hidden');
        }

        if (frames.current === frames.start) {
            this._firstButtonUI.addClass('disabledPlayerButton');
            this._prevButtonUI.addClass('disabledPlayerButton');
            this._multiplePrevButtonUI.addClass('disabledPlayerButton');
        } else {
            this._firstButtonUI.removeClass('disabledPlayerButton');
            this._prevButtonUI.removeClass('disabledPlayerButton');
            this._multiplePrevButtonUI.removeClass('disabledPlayerButton');
        }

        if (frames.current === frames.stop) {
            this._lastButtonUI.addClass('disabledPlayerButton');
            this._nextButtonUI.addClass('disabledPlayerButton');
            this._playButtonUI.addClass('disabledPlayerButton');
            this._multipleNextButtonUI.addClass('disabledPlayerButton');
        } else {
            this._lastButtonUI.removeClass('disabledPlayerButton');
            this._nextButtonUI.removeClass('disabledPlayerButton');
            this._playButtonUI.removeClass('disabledPlayerButton');
            this._multipleNextButtonUI.removeClass('disabledPlayerButton');
        }

        this._progressUI['0'].value = frames.current - frames.start;

        this._rotationWrapperUI.css('transform', `rotate(${geometry.rotation}deg)`);

        for (const obj of [this._playerBackgroundUI, this._playerGridUI]) {
            obj.css('width', image.width);
            obj.css('height', image.height);
            obj.css('top', geometry.top);
            obj.css('left', geometry.left);
            obj.css('transform', `scale(${geometry.scale})`);
        }

        for (const obj of [this._playerContentUI, this._playerTextUI]) {
            obj.css('width', image.width + geometry.frameOffset * 2);
            obj.css('height', image.height + geometry.frameOffset * 2);
            obj.css('top', geometry.top - geometry.frameOffset * geometry.scale);
            obj.css('left', geometry.left - geometry.frameOffset * geometry.scale);
        }

        this._playerContentUI.css('transform', `scale(${geometry.scale})`);
        this._playerTextUI.css('transform', `scale(10) rotate(${-geometry.rotation}deg)`);
        this._playerGridPath.attr('stroke-width', 2 / geometry.scale);
        this._frameNumber.prop('value', frames.current);
    }
}
