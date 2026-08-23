import { defineConfig, type Plugin } from 'vite'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
// データ生成パイプラインの成果物（PMTiles）はリポジトリ直下 dist/ にある。
const PMTILES_DIR = resolve(rootDir, '..', 'dist')

/**
 * 開発サーバーで dist/*.pmtiles を Range(206) 対応で配信するミドルウェア。
 * pmtiles.js は HTTP Byte Serving を要求するため、これがないとタイルを読めない。
 * 本番では nginx/apache 等が Range をネイティブに処理するので不要。
 */
function pmtilesDevServer(): Plugin {
  return {
    name: 'pmtiles-dev-server',
    configureServer(server) {
      server.middlewares.use('/pmtiles', (req, res, next) => {
        try {
          const urlPath = decodeURIComponent((req.url ?? '').split('?')[0])
          const rel = normalize(urlPath).replace(/^([/\\]|\.\.[/\\])+/, '')
          const file = join(PMTILES_DIR, rel)
          if (!file.startsWith(PMTILES_DIR) || !existsSync(file)) {
            res.statusCode = 404
            res.end('Not found')
            return
          }
          const size = statSync(file).size
          res.setHeader('Accept-Ranges', 'bytes')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Content-Type', 'application/octet-stream')

          const range = req.headers.range
          const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
          if (m) {
            const start = m[1] ? parseInt(m[1], 10) : 0
            let end = m[2] ? parseInt(m[2], 10) : size - 1
            end = Math.min(end, size - 1)
            if (start > end || start >= size) {
              res.statusCode = 416
              res.setHeader('Content-Range', `bytes */${size}`)
              res.end()
              return
            }
            res.statusCode = 206
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
            res.setHeader('Content-Length', String(end - start + 1))
            createReadStream(file, { start, end }).pipe(res)
            return
          }

          res.statusCode = 200
          res.setHeader('Content-Length', String(size))
          createReadStream(file).pipe(res)
        } catch (err) {
          next(err)
        }
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [pmtilesDevServer()],
  server: { port: 8000 },
})
