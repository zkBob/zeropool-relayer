const path = require('path')
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin')

const isProduction = process.env.NODE_ENV == 'production'

const config = {
  entry: './src/generate.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
  },
  plugins: [
    new NodePolyfillPlugin({
      excludeAliases: ['console'],
    }),
  ],
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/i,
        loader: 'ts-loader',
        exclude: path.resolve(__dirname, 'node_modules'),
      },
      {
        test: /\.(eot|svg|ttf|woff|woff2|png|jpg|gif)$/i,
        type: 'asset',
      },
      {
        test: /\.json$/,
        use: ['json-loader'],
        type: 'javascript/auto',
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // fallback: {
    //   "http": require.resolve("stream-http")
    // }
  },
  experiments: {
    asyncWebAssembly: true,
    topLevelAwait: true,
  },
}

module.exports = () => {
  if (isProduction) {
    config.mode = 'production'
  } else {
    config.mode = 'development'
  }
  return config
}
