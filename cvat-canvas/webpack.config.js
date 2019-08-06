/* global
    require:true,
    __dirname:true,
*/

const path = require('path');

module.exports = {
    target: 'web',
    mode: 'production',
    devtool: 'source-map',
    entry: './src/canvas.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'cvat-canvas.js',
        library: 'canvas',
        libraryTarget: 'window',
    },
    devServer: {
        contentBase: path.join(__dirname, 'dist'),
        compress: false,
        inline: true,
        port: 3000,
    },
    resolve: {
        extensions: ['.ts', '.js', '.json'],
    },
    module: {
        rules: [{
            exclude: /node_modules/,
            use: {
                loader: 'babel-loader',
                options: {
                    presets: [
                        [
                            '@babel/preset-env',
                        ],
                        [
                            '@babel/typescript',
                        ],
                    ],
                    sourceType: 'unambiguous',
                },
            },
        }],
    },
};
