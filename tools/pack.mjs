// 打包发布包：直接用项目自带的 zip 写入器，不建暂存目录。
// 用法：node tools/pack.mjs <源目录> <输出 zip>
// 只打包程序本身：config / logs / backups / restore-points 这些运行时数据一律不进包。
import fs from 'node:fs'
import path from 'node:path'
import * as zip from '../lib/zip.js'

const src = process.argv[2] || '.'
const out = process.argv[3] || 'DSH-start.zip'

const INCLUDE_DIRS = ['server', 'lib', 'public', 'tools']
const INCLUDE_FILES = ['package.json', 'README.md', 'app.ico', 'DSH-start.exe', '.gitignore']

const files = []

function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      // 不发布启动器编译产物、AssemblyInfo 临时文件
      if (e.name === 'node_modules' || e.name === '.git') continue
      walk(full, r)
    } else if (e.isFile()) {
      if (e.name === 'AssemblyInfo.cs' || e.name === 'app.manifest') continue
      files.push({ name: r, absPath: full })
    }
  }
}

for (const d of INCLUDE_DIRS) {
  const full = path.join(src, d)
  if (fs.existsSync(full)) walk(full, d)
}
for (const f of INCLUDE_FILES) {
  const full = path.join(src, f)
  if (fs.existsSync(full)) files.push({ name: f, absPath: full })
}

if (!files.length) {
  console.error('没有可打包的文件')
  process.exit(1)
}

const res = await zip.write(out, files, { level: 9 })
const list = zip.readEntries(out)
console.log(`打包完成：${out}`)
console.log(`  大小 ${(res.size / 1024).toFixed(1)} KB，${list.length} 个条目`)
console.log('  ' + list.map((e) => e.name).join('  '))

// 逐条校验：CRC 能过说明文件没坏
let bad = 0
for (const e of list) {
  try {
    zip.readEntryBuffer(out, e)
  } catch (err) {
    bad++
    console.error('  ✗ ' + e.name + '：' + err.message)
  }
}
console.log(bad ? `✗ ${bad} 个条目损坏` : '  ✓ 全部条目校验通过')
