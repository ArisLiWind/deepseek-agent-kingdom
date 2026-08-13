/* ============================================================================
 * Aris Kingdom · 体素预览世界 — game.js
 * ----------------------------------------------------------------------------
 * 纯静态 Three.js 体素世界（无构建 / 无打包，Vercel 可部署）。
 * 画风目标：温暖可爱（洛克王国 × 星露谷 × 我的世界三合一），
 *           暖色天空渐变、嫩绿草地、墨色描边、Q 版二头身方块人。
 *
 * 架构总览：
 *   1. 程序地形：自写 value-noise + fBm 高度图（确定性，seed 可经 ?seed= 覆盖）
 *   2. 体素渲染：每区块 2 个 InstancedMesh（不透明块 + 水），
 *      6 向邻居面剔除（贴合面不画），自定义 ShaderMaterial（顶/侧双色 + 伪 AO）
 *   3. 区块流式：16×16 区块，视距 3，按玩家位置动态加载/卸载，增量重建
 *   4. Q 版化身：二头身方块人（圆角头 + 呆毛 + 眼睛腮红 + 精灵伙伴 + 名字悬浮标签）
 *   5. 操控：WASD + 拖拽环视 + 空格跳跃；触屏左摇杆 + 右半屏环视
 *   6. 数据接缝：loadWorldStatus / loadAgents / enterWorld（缺省优雅降级 → 离线漫游）
 * ========================================================================== */

import * as THREE from 'three'

/* ============================ 0. 常量与工具 ============================ */

// 世界颜色板（对齐 world-visual-spec-v1 色板）
const PALETTE = {
  grass:   { top: 0x8ed060, side: 0x9c6a3d }, // 嫩绿顶 + 泥土侧
  dirt:    { top: 0xb0885a, side: 0x9c7448 },
  stone:   { top: 0x9aa0a6, side: 0x7a8290 },
  wood:    { top: 0xc9974f, side: 0xa5793f }, // 木头
  leaves:  { top: 0x6ec05a, side: 0x5fae4e },
  sand:    { top: 0xf0dc9a, side: 0xe8d18a },
  plank:   { top: 0xd0a45f, side: 0xb98a4a }, // 桥面木板
  crystal: { top: 0xd0c0ff, side: 0xb28dff }, // 魔法水晶（带自发光）
  flower:  { top: 0xff8fb0, side: 0xff8fb0 },
}
const WATER_TOP = 0x69c0e8
const WATER_SIDE = 0x4fa8d8
const FLOWER_COLORS = [0xff8fb0, 0xffd166, 0xb28dff, 0xfff3c4] // 粉/黄/紫/白

const SEA = 7          // 海平面（方块 y 值；水面世界高度 = SEA + 1）
const CHUNK = 16       // 区块尺寸
const VIEW = 3         // 视距（区块数）：7×7 = 49 区块
const OPQ_CAP = 4096   // 每区块不透明实例容量
const WAT_CAP = 768    // 每区块水实例容量
const GRAVITY = 24
const JUMP_V = 8.2
const WALK_SPEED = 7.0
const SWIM_SPEED = 3.2
const EYE = 1.55
const P_HALF = 0.32    // 玩家半宽（碰撞用）
const P_HEIGHT = 1.7   // 玩家身高

const $ = (id) => document.getElementById(id)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, t) => a + (b - a) * t
const smoothstep = (x, a, b) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const fmt = (n) => (n === undefined || n === null || Number.isNaN(n) ? '—' : n)

// 圆角矩形路径（兼容无 ctx.roundRect 的旧浏览器）
function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// 确定性字符串哈希（角色配色来源）
function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/* ============================ 1. 噪声与程序地形 ============================ */

const SEED = parseSeed()
function parseSeed() {
  const raw = new URLSearchParams(location.search).get('seed')
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? Math.abs(n | 0) : 20250814 // 固定默认 seed → 确定性
}

// 整数格点哈希 → [0,1)
function hash2i(x, z, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 974634511)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296
}

// 2D value-noise（平滑插值，无外部库）
function valueNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z)
  const xf = x - xi, zf = z - zi
  const a = hash2i(xi, zi, seed)
  const b = hash2i(xi + 1, zi, seed)
  const c = hash2i(xi, zi + 1, seed)
  const d = hash2i(xi + 1, zi + 1, seed)
  const u = xf * xf * (3 - 2 * xf)
  const v = zf * zf * (3 - 2 * zf)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

// fBm：4 个八度叠加
function fbm(x, z, seed) {
  let v = 0, amp = 0.5, f = 1, n = 0
  for (let o = 0; o < 4; o++) {
    v += valueNoise(x * f, z * f, seed + o * 101) * amp
    n += amp
    amp *= 0.5
    f *= 2.03
  }
  return v / n
}

// 小溪中心线（蜿蜒）：z = 12 + sin(x*0.055)*5.5
const streamZ = (x) => 12 + Math.sin(x * 0.055) * 5.5

// 高度图：出生点附近平坦（8），远处丘陵，小溪处下切到 SEA-2
function heightAt(x, z) {
  const dStream = Math.abs(z - streamZ(x))
  let h = 6 + fbm(x * 0.021, z * 0.021, SEED) * 15 + fbm(x * 0.07 + 31, z * 0.07 + 17, SEED + 7) * 2.5
  const flatT = smoothstep(Math.hypot(x, z), 5, 28) // 0 = 出生点 → 1 = 远处
  h = lerp(8, h, flatT)
  if (dStream < 1.9) h = Math.min(h, SEA - 2)
  return Math.max(1, Math.round(h))
}

// 树（确定性）：不在小溪/海滩/出生点，密度 ~3%，树干 3-5 格
function treeAt(x, z) {
  const h = heightAt(x, z)
  if (Math.abs(z - streamZ(x)) < 2.2) return null
  if (Math.hypot(x, z) < 14) return null
  if (h <= SEA + 1) return null
  if (hash2i(x, z, SEED ^ 0x9e37) > 0.030) return null
  return { h, trunkH: 3 + Math.floor(hash2i(x, z, SEED + 5) * 2.4) }
}

// 树叶：树冠 4 层（半径 2/2/1/0）
function isLeafAt(x, z, tr, y) {
  const top = tr.h + tr.trunkH + 1
  const layer = top - y
  if (layer < 0 || layer > 3) return false
  const r = [0, 1, 2, 2][layer]
  const dx = Math.abs(x - tr.x), dz = Math.abs(z - tr.z)
  if (r === 0) return dx === 0 && dz === 0
  return dx <= r && dz <= r && dx + dz <= r + 1
}

// 花 / 水晶
function flowerAt(x, z) {
  const h = heightAt(x, z)
  if (h <= SEA + 1 || Math.abs(z - streamZ(x)) < 2.2) return null
  if (hash2i(x, z, SEED + 11) > 0.10) return null
  return { v: Math.floor(hash2i(x, z, SEED + 13) * 4) }
}
function crystalAt(x, z) {
  const h = heightAt(x, z)
  if (h <= 15) return null
  if (hash2i(x, z, SEED + 17) > 0.09) return null
  return { h: 1 + (hash2i(x, z, SEED + 19) < 0.5 ? 1 : 0) }
}

// 星门大桥（公共工程，进度可视化）—— 跨小溪的木板桥 + 水晶拱门
let bridgeProgress = 0.35 // 0~1，由 world/status 更新
function bridgeDeckY(x, z) {
  if (z < 7 || z > 17 || Math.abs(x) > 1) return null
  return Math.max(SEA + 2, heightAt(x, z) + 1)
}
function bridgeBlock(x, y, z) {
  const deckY = bridgeDeckY(x, z)
  const h = heightAt(x, z)
  if (deckY !== null) {
    // 桥面板：进度决定已铺设的木板数（总 11 z × 3 x = 33 块）
    if (y === deckY) {
      const idx = (z - 7) * 3 + (x + 1)
      const visible = Math.round(bridgeProgress * 33)
      return idx < visible ? 'plank' : null
    }
    // 桥两侧扶手
    if (y === deckY + 1 && (z === 7 || z === 17)) return 'wood'
  }
  // 桥墩（石柱）
  if ((x === -4 || x === 4) && z === 12 && y > h && y <= SEA + 3) return 'stone'
  // 水晶拱门（进度驱动，左→右亮起 9 颗）
  if (z === 12 && Math.abs(x) <= 3) {
    const arcY = Math.round(9.5 + (1 - (x * x) / 16) * 4)
    if (y === arcY && y >= SEA + 3 && x + 4 < Math.round(bridgeProgress * 9)) return 'crystal'
  }
  return null
}

// 单列地形信息（缓存用：每列只算一次高度/树/花/水晶）
function columnInfo(x, z) {
  return { x, z, h: heightAt(x, z), tr: treeAt(x, z), fl: flowerAt(x, z), cr: crystalAt(x, z) }
}

// 方块类型判定：x/y/z 为方块整数坐标（方块占据 y..y+1，地形最顶 y = h）
function blockTypeAt(x, y, z, info) {
  info = info || columnInfo(x, z)
  const { h, tr, fl, cr } = info
  if (Math.abs(x) <= 6 && z >= 6 && z <= 18) {
    const b = bridgeBlock(x, y, z)
    if (b) return b
  }
  if (tr) {
    if (y > h && y <= h + tr.trunkH) return 'wood'
    if (isLeafAt(x, z, tr, y)) return 'leaves'
  }
  if (cr && y >= h + 1 && y <= h + cr.h) return 'crystal'
  if (fl && y === h + 1) return 'flower'
  if (y === h) {
    if (h <= SEA) return 'sand'
    if (Math.abs(z - streamZ(x)) < 2.6) return 'sand'
    if (h > 16 && hash2i(x, z, SEED + 3) < 0.5) return 'stone'
    return 'grass'
  }
  if (y > h && y <= SEA) return 'water'
  if (y < h) return h - y <= 3 ? 'dirt' : 'stone'
  return null
}

// 哪些方块会遮挡相邻面（水/花/空气不遮挡）
const OCCLUDES = { grass: 1, dirt: 1, stone: 1, wood: 1, leaves: 1, sand: 1, plank: 1, crystal: 1 }
const isOccluder = (t) => t !== null && t !== 'water' && t !== 'flower' && OCCLUDES[t] !== undefined

/* ============================ 2. 体素渲染（InstancedMesh 合批） ============================ */

// 36 顶点盒体（6 面 × 2 三角，无索引），每顶点带 faceId（0..5：+x,-x,+y,-y,+z,-z）
const BOX_POS = new Float32Array(36 * 3)
const BOX_NORMAL = new Float32Array(36 * 3)
const BOX_FACE = new Float32Array(36)
{
  const H = 0.5
  const faces = [
    { n: [1, 0, 0], c: [[H, -H, -H], [H, H, -H], [H, H, H], [H, -H, H]] },
    { n: [-1, 0, 0], c: [[-H, -H, H], [-H, H, H], [-H, H, -H], [-H, -H, -H]] },
    { n: [0, 1, 0], c: [[-H, H, -H], [-H, H, H], [H, H, H], [H, H, -H]] },
    { n: [0, -1, 0], c: [[-H, -H, H], [-H, -H, -H], [H, -H, -H], [H, -H, H]] },
    { n: [0, 0, 1], c: [[-H, -H, H], [-H, H, H], [H, H, H], [H, -H, H]] },
    { n: [0, 0, -1], c: [[H, -H, -H], [H, H, -H], [-H, H, -H], [-H, -H, -H]] },
  ]
  let i = 0
  for (let f = 0; f < 6; f++) {
    const { n, c } = faces[f]
    const idx = [0, 1, 2, 0, 2, 3]
    for (const k of idx) {
      BOX_POS[i * 3] = c[k][0]; BOX_POS[i * 3 + 1] = c[k][1]; BOX_POS[i * 3 + 2] = c[k][2]
      BOX_NORMAL[i * 3] = n[0]; BOX_NORMAL[i * 3 + 1] = n[1]; BOX_NORMAL[i * 3 + 2] = n[2]
      BOX_FACE[i] = f
      i++
    }
  }
}
const SHARED_POS = new THREE.BufferAttribute(BOX_POS, 3)
const SHARED_NORMAL = new THREE.BufferAttribute(BOX_NORMAL, 3)
const SHARED_FACE = new THREE.BufferAttribute(BOX_FACE, 1)

// 自定义地形 ShaderMaterial（顶/侧双色 + 面剔除 mask + 半球光 + 伪 AO + 自发光 + 暖雾）
function buildTerrainShader({ isWater }) {
  const vert = /* glsl */ `
    attribute float faceId;
    attribute vec3 aColorTop;
    attribute vec3 aColorSide;
    attribute float aMask;
    attribute float aEmis;
    varying vec3 vColorTop;
    varying vec3 vColorSide;
    varying float vFace;
    varying float vMask;
    varying float vEmis;
    varying vec3 vNormalW;
    varying vec3 vWorldPos;
    varying float vDepth;
    void main() {
      vec4 worldPos = instanceMatrix * vec4(position, 1.0);
      vec4 mvPosition = modelViewMatrix * worldPos;
      gl_Position = projectionMatrix * mvPosition;
      vNormalW = normalize(mat3(instanceMatrix) * normal);
      vColorTop = aColorTop;
      vColorSide = aColorSide;
      vFace = faceId;
      vMask = aMask;
      vEmis = aEmis;
      vWorldPos = worldPos.xyz;
      vDepth = -mvPosition.z;
    }
  `
  const frag = /* glsl */ `
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform vec3 uSkyColor;
    uniform vec3 uGroundColor;
    uniform vec3 uFogColor;
    uniform float uFogNear;
    uniform float uFogFar;
    uniform float uOpacity;
    uniform float uTime;
    varying vec3 vColorTop;
    varying vec3 vColorSide;
    varying float vFace;
    varying float vMask;
    varying float vEmis;
    varying vec3 vNormalW;
    varying vec3 vWorldPos;
    varying float vDepth;
    void main() {
      // 面剔除：mask 的对应位为 0 → 该面被相邻方块遮挡，不画
      float bit = pow(2.0, vFace);
      if (mod(floor(vMask / bit), 2.0) < 0.5) discard;

      vec3 base = (vFace > 1.5 && vFace < 2.5) ? vColorTop : vColorSide;
      vec3 n = normalize(vNormalW);

      // 半球光（天蓝→暖地） + 暖太阳光 + 基础环境 —— 温暖不灰暗
      vec3 hemiCol = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
      float sun = max(dot(n, normalize(uSunDir)), 0.0);
      vec3 col = base * (hemiCol * 0.62 + uSunColor * sun * 0.72 + 0.16);

      // 伪 AO：顶面亮 / 侧面中 / 底面暗
      float ao = 1.0;
      if (vFace > 2.5 && vFace < 3.5) ao = 0.6;
      else if (vFace > 0.5) ao = 0.88;
      col *= ao;

      // 自发光（水晶 / 花）
      col += base * vEmis * 0.9;

      // 水面波光
      if (${isWater}) {
        float sparkle = pow(max(sin(vWorldPos.x * 2.4 + uTime * 1.9) * sin(vWorldPos.z * 2.4 - uTime * 1.5), 0.0), 3.0);
        col += vec3(0.85, 0.98, 1.0) * sparkle * 0.22;
      }

      // 暖雾淡出
      float fogF = smoothstep(uFogNear, uFogFar, vDepth);
      col = mix(col, uFogColor, fogF);

      // 手动 sRGB 编码（ShaderMaterial 不自动做色彩空间转换）
      col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
      gl_FragColor = vec4(col, uOpacity);
    }
  `
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    // 注意：uniforms 必须在构造时提供占位，three 只在首次编译时才惰性补齐未声明的 uniform
    uniforms: { uOpacity: { value: isWater ? 0.78 : 1 } },
    transparent: isWater,
    depthWrite: !isWater,
    side: THREE.FrontSide,
  })
}

const TERRAIN_MAT = buildTerrainShader({ isWater: false })
const WATER_MAT = buildTerrainShader({ isWater: true })
WATER_MAT.renderOrder = 2

// 通用实例 uniforms（与 scene.fog / 灯光同步）
const SHARED_UNIFORMS = {
  uSunDir: { value: new THREE.Vector3(0.55, 0.85, 0.4).normalize() },
  uSunColor: { value: new THREE.Color(0xfff1d0) },
  uSkyColor: { value: new THREE.Color(0xbfe3ff) },
  uGroundColor: { value: new THREE.Color(0xffe9c7) },
  uFogColor: { value: new THREE.Color(0xf2e0be) },
  uFogNear: { value: 35 },
  uFogFar: { value: 130 },
  uTime: { value: 0 },
}
for (const [k, v] of Object.entries(SHARED_UNIFORMS)) {
  TERRAIN_MAT.uniforms[k] = v
  WATER_MAT.uniforms[k] = v
}

// 每区块网格：2 个 InstancedMesh（不透明 + 水），增量重建
const chunkMeshes = new Map() // key "cx,cz" -> { opq, wat, opqCount, watCount, geo }

function createChunkMeshes(key) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', SHARED_POS)
  geo.setAttribute('normal', SHARED_NORMAL)
  geo.setAttribute('faceId', SHARED_FACE)

  const opqMat = new Float32Array(OPQ_CAP * 16)
  const opqTop = new Float32Array(OPQ_CAP * 3)
  const opqSide = new Float32Array(OPQ_CAP * 3)
  const opqMask = new Float32Array(OPQ_CAP)
  const opqEmis = new Float32Array(OPQ_CAP)

  const opq = new THREE.InstancedMesh(geo, TERRAIN_MAT, OPQ_CAP)
  opq.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  opq.instanceMatrix.array = opqMat
  opq.frustumCulled = false
  geo.setAttribute('aColorTop', new THREE.InstancedBufferAttribute(opqTop, 3).setUsage(THREE.DynamicDrawUsage))
  geo.setAttribute('aColorSide', new THREE.InstancedBufferAttribute(opqSide, 3).setUsage(THREE.DynamicDrawUsage))
  geo.setAttribute('aMask', new THREE.InstancedBufferAttribute(opqMask, 1).setUsage(THREE.DynamicDrawUsage))
  geo.setAttribute('aEmis', new THREE.InstancedBufferAttribute(opqEmis, 1).setUsage(THREE.DynamicDrawUsage))
  opq.count = 0
  scene.add(opq)

  const watGeo = new THREE.BufferGeometry()
  watGeo.setAttribute('position', SHARED_POS)
  watGeo.setAttribute('normal', SHARED_NORMAL)
  watGeo.setAttribute('faceId', SHARED_FACE)
  const watMat = new Float32Array(WAT_CAP * 16)
  const watTop = new Float32Array(WAT_CAP * 3)
  const watSide = new Float32Array(WAT_CAP * 3)
  const watMask = new Float32Array(WAT_CAP)
  const watEmis = new Float32Array(WAT_CAP)
  const wat = new THREE.InstancedMesh(watGeo, WATER_MAT, WAT_CAP)
  wat.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  wat.instanceMatrix.array = watMat
  wat.frustumCulled = false
  watGeo.setAttribute('aColorTop', new THREE.InstancedBufferAttribute(watTop, 3).setUsage(THREE.DynamicDrawUsage))
  watGeo.setAttribute('aColorSide', new THREE.InstancedBufferAttribute(watSide, 3).setUsage(THREE.DynamicDrawUsage))
  watGeo.setAttribute('aMask', new THREE.InstancedBufferAttribute(watMask, 1).setUsage(THREE.DynamicDrawUsage))
  watGeo.setAttribute('aEmis', new THREE.InstancedBufferAttribute(watEmis, 1).setUsage(THREE.DynamicDrawUsage))
  wat.count = 0
  scene.add(wat)

  const entry = {
    opq, wat, geo: watGeo,
    opqMat, opqTop, opqSide, opqMask, opqEmis,
    watMat, watTop, watSide, watMask, watEmis,
  }
  chunkMeshes.set(key, entry)
  return entry
}

// 颜色缓存（避免每实例重复 new Color）
const _c = new THREE.Color()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _v = new THREE.Vector3()

// 重建单个区块的实例数据（面剔除 + 双色 + 顶/侧/底伪 AO 色差）
function rebuildChunk(cx, cz) {
  const key = cx + ',' + cz
  let entry = chunkMeshes.get(key)
  if (!entry) entry = createChunkMeshes(key)

  const colCache = new Map() // 列信息缓存（本区块一次重建内共享）
  const col = (x, z) => {
    const k = x + ',' + z
    let v = colCache.get(k)
    if (!v) { v = columnInfo(x, z); colCache.set(k, v) }
    return v
  }
  const type = (x, y, z) => blockTypeAt(x, y, z, col(x, z))

  let oi = 0, wi = 0
  const baseX = cx * CHUNK, baseZ = cz * CHUNK

  for (let lx = 0; lx < CHUNK; lx++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      const x = baseX + lx, z = baseZ + lz
      const info = col(x, z)
      // 本列可能的最高方块
      let topY = Math.max(SEA, info.h + (info.tr ? info.tr.trunkH + 2 : 0))
      if (info.cr) topY = Math.max(topY, info.h + info.cr.h)
      if (Math.abs(x) <= 6 && z >= 6 && z <= 18) topY = Math.max(topY, 16)

      for (let y = 0; y <= topY; y++) {
        const t = blockTypeAt(x, y, z, info)
        if (!t) continue

        // —— 6 向邻居面剔除：贴合面不画 ——
        const up = isOccluder(type(x, y + 1, z))
        const down = isOccluder(type(x, y - 1, z))
        const px = isOccluder(type(x + 1, y, z))
        const nx = isOccluder(type(x - 1, y, z))
        const pz = isOccluder(type(x, y, z + 1))
        const nz = isOccluder(type(x, y, z - 1))
        let mask = 0
        if (!px) mask |= 1 << 0
        if (!nx) mask |= 1 << 1
        if (!up) mask |= 1 << 2
        if (!down) mask |= 1 << 3
        if (!pz) mask |= 1 << 4
        if (!nz) mask |= 1 << 5
        if (mask === 0) continue // 完全被埋：不实例化

        const isWater = t === 'water'
        const cap = isWater ? WAT_CAP : OPQ_CAP
        const n = isWater ? wi : oi
        if (n >= cap) { console.warn('[world-viz] chunk', key, '实例超容量:', t); continue }

        // 颜色（含每实例轻微色差，避免死板）
        const rnd = hash2i(x, y, z, SEED + 99)
        const tint = 0.92 + rnd * 0.12
        let top, side
        if (isWater) { top = WATER_TOP; side = WATER_SIDE }
        else if (t === 'flower') { top = side = FLOWER_COLORS[info.fl ? info.fl.v : 0] }
        else { top = PALETTE[t].top; side = PALETTE[t].side }
        _c.setHex(top).multiplyScalar(tint)
        const rT = _c.r, gT = _c.g, bT = _c.b
        _c.setHex(side).multiplyScalar(tint)
        const rS = _c.r, gS = _c.g, bS = _c.b

        // 实例矩阵：位置 + （花 0.62 缩放）
        const scale = t === 'flower' ? 0.62 : 1
        _q.identity()
        _s.set(scale, scale, scale)
        _m.compose(_v.set(x + 0.5, y + 0.5, z + 0.5), _q, _s)

        const arr = isWater ? entry.watMat : entry.opqMat
        const o = n * 16
        arr.set(_m.elements, o)
        if (isWater) {
          entry.watTop[n * 3] = rT; entry.watTop[n * 3 + 1] = gT; entry.watTop[n * 3 + 2] = bT
          entry.watSide[n * 3] = rS; entry.watSide[n * 3 + 1] = gS; entry.watSide[n * 3 + 2] = bS
          entry.watMask[n] = mask
          entry.watEmis[n] = 0
          wi++
        } else {
          entry.opqTop[n * 3] = rT; entry.opqTop[n * 3 + 1] = gT; entry.opqTop[n * 3 + 2] = bT
          entry.opqSide[n * 3] = rS; entry.opqSide[n * 3 + 1] = gS; entry.opqSide[n * 3 + 2] = bS
          entry.opqMask[n] = mask
          entry.opqEmis[n] = t === 'crystal' ? 0.85 : t === 'flower' ? 0.25 : 0
          oi++
        }
      }
    }
  }

  entry.opq.count = oi
  entry.wat.count = wi
  entry.opq.instanceMatrix.needsUpdate = true
  entry.wat.instanceMatrix.needsUpdate = true
  ;(entry.opq.geometry.getAttribute('aColorTop')).needsUpdate = true
  ;(entry.opq.geometry.getAttribute('aColorSide')).needsUpdate = true
  ;(entry.opq.geometry.getAttribute('aMask')).needsUpdate = true
  ;(entry.opq.geometry.getAttribute('aEmis')).needsUpdate = true
  ;(entry.wat.geometry.getAttribute('aColorTop')).needsUpdate = true
  ;(entry.wat.geometry.getAttribute('aColorSide')).needsUpdate = true
  ;(entry.wat.geometry.getAttribute('aMask')).needsUpdate = true
  ;(entry.wat.geometry.getAttribute('aEmis')).needsUpdate = true
}

// 区块流式：以玩家所在区块为中心，加载/卸载视距内区块
const chunks = new Set() // 已加载区块 key 集合
function playerChunkKey() {
  return `${Math.floor(player.x / CHUNK)},${Math.floor(player.z / CHUNK)}`
}
function updateChunks(force) {
  const [pcx, pcz] = playerChunkKey().split(',').map(Number)
  let changed = false
  for (let dx = -VIEW; dx <= VIEW; dx++) {
    for (let dz = -VIEW; dz <= VIEW; dz++) {
      const cx = pcx + dx, cz = pcz + dz
      const key = cx + ',' + cz
      if (!chunks.has(key)) { chunks.add(key); rebuildChunk(cx, cz); changed = true }
    }
  }
  for (const key of [...chunks]) {
    const [cx, cz] = key.split(',').map(Number)
    if (Math.abs(cx - pcx) > VIEW + 1 || Math.abs(cz - pcz) > VIEW + 1) {
      chunks.delete(key)
      const e = chunkMeshes.get(key)
      if (e) { scene.remove(e.opq); scene.remove(e.wat); chunkMeshes.delete(key) }
      changed = true
    }
  }
  return changed
}
function rebuildAllChunks() {
  for (const key of chunks) {
    const [cx, cz] = key.split(',').map(Number)
    rebuildChunk(cx, cz)
  }
}

/* ============================ 3. 场景搭建 ============================ */

let renderer, scene, camera
let skyDome, clouds = [], particlePoints, particlePos, particleSeed

function setupScene() {
  const canvas = $('scene')
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping // 自定义 shader 已手动 sRGB，统一不做 tonemap

  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(SHARED_UNIFORMS.uFogColor.value.getHex(), 35, 130)

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 600)
  camera.rotation.order = 'YXZ'

  buildSky()
  buildLights()
  buildClouds()
  buildParticles()
  buildBridgeLabel()
  buildDeedHighlight()

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })
}

// 暖色天空渐变穹顶（#8fd0e8 → #ffe9c7）
function buildSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTop: { value: new THREE.Color(0x8fd0e8) }, uHorizon: { value: new THREE.Color(0xffe9c7) } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      void main() {
        float t = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(uHorizon, uTop, pow(t, 1.4));
        float band = exp(-abs(vDir.y) * 6.0);
        col = mix(col, uHorizon, band * 0.5);
        col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  skyDome = new THREE.Mesh(new THREE.SphereGeometry(380, 24, 16), mat)
  skyDome.renderOrder = -10
  scene.add(skyDome)
}

// 偏暖方向光 + 半球天光 + 微量环境（柔和暖光，无实时阴影 → 伪 AO 代替）
function buildLights() {
  const sun = new THREE.DirectionalLight(0xfff1d0, 1.7)
  sun.position.set(60, 90, 40)
  scene.add(sun)
  scene.add(new THREE.HemisphereLight(0xbfe3ff, 0xffe9c7, 0.95))
  scene.add(new THREE.AmbientLight(0xfff0d8, 0.25))
}

// 缓慢飘云（低多边形小方块团）
function buildClouds() {
  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const mat = new THREE.MeshLambertMaterial({ color: 0xfffdf6, transparent: true, opacity: 0.94 })
  for (let i = 0; i < 12; i++) {
    const g = new THREE.Group()
    const blobs = 4 + Math.floor(Math.random() * 3)
    for (let b = 0; b < blobs; b++) {
      const m = new THREE.Mesh(boxGeo, mat)
      m.scale.set(2.2 + Math.random() * 2.6, 1.1 + Math.random() * 0.8, 1.8 + Math.random() * 2.0)
      m.position.set((b - blobs / 2) * 2.1, Math.random() * 0.6, (Math.random() - 0.5) * 2.4)
      g.add(m)
    }
    g.position.set(Math.random() * 700 - 350, 55 + Math.random() * 22, Math.random() * 700 - 350)
    g.userData.speed = 1.1 + Math.random() * 1.3
    clouds.push(g)
    scene.add(g)
  }
}

// 低开销粒子：光点/花瓣（Points + 加法混合）
function buildParticles() {
  const N = 220
  particlePos = new Float32Array(N * 3)
  particleSeed = new Float32Array(N * 3) // 基准位置
  const colors = new Float32Array(N * 3)
  const dot = makeDotTexture()
  for (let i = 0; i < N; i++) {
    particleSeed[i * 3] = (Math.random() - 0.5) * 120
    particleSeed[i * 3 + 1] = Math.random() * 36 + 2
    particleSeed[i * 3 + 2] = (Math.random() - 0.5) * 120
    const warm = Math.random()
    if (warm < 0.6) { colors[i * 3] = 1; colors[i * 3 + 1] = 0.92; colors[i * 3 + 2] = 0.66 }        // 暖光点
    else { colors[i * 3] = 1; colors[i * 3 + 1] = 0.62; colors[i * 3 + 2] = 0.72 }                    // 粉花瓣
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3).setUsage(THREE.DynamicDrawUsage))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.55, map: dot, vertexColors: true, transparent: true, opacity: 0.6,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  })
  particlePoints = new THREE.Points(geo, mat)
  scene.add(particlePoints)
}

function makeDotTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')
  const grd = ctx.createRadialGradient(32, 32, 2, 32, 32, 30)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  return tex
}

/* ============================ 4. Q 版化身 ============================ */

let RoundedBoxGeometry = null
import('three/addons/geometries/RoundedBoxGeometry.js')
  .then((m) => { RoundedBoxGeometry = m.RoundedBoxGeometry })
  .catch(() => { /* CDN 缺省回退普通 BoxGeometry */ })

function roundedBox(w, h, d, r) {
  return RoundedBoxGeometry ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d)
}

const avatars = [] // { group, shadow, label, groundH, phase, name, role }
const exampleAvatars = [] // 内置示例化身引用（API 成功后移除）
const labelsToRedraw = []

// 名字标签：CanvasTexture → Sprite（名字 + 职业；示例化身标注「示例」）
function makeLabel(name, role, isExample) {
  const c = document.createElement('canvas')
  c.width = 340; c.height = 120
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  sprite.scale.set(3.6, 1.27, 1)

  const draw = () => {
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    // 奶油底 + 墨描边
    roundRectPath(ctx, 8, 8, c.width - 16, c.height - 16, 16)
    ctx.fillStyle = 'rgba(246,236,212,0.96)'
    ctx.fill()
    ctx.lineWidth = 7
    ctx.strokeStyle = '#3a2e24'
    ctx.stroke()
    // 名字
    const px = Math.min(30, Math.max(14, Math.floor(280 / Math.max(1, name.length * 1.05))))
    ctx.font = `${px}px "Press Start 2P", "ZCOOL KuaiLe", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#3a2e24'
    ctx.fillText(name, c.width / 2, 42)
    // 职业 + （示例）徽记
    ctx.font = '21px "ZCOOL KuaiLe", "Press Start 2P", sans-serif'
    ctx.fillStyle = isExample ? '#b28dff' : '#a5793f'
    ctx.fillText(role + (isExample ? ' · 示例' : ''), c.width / 2, 82)
    tex.needsUpdate = true
  }
  draw()
  labelsToRedraw.push(draw)
  return sprite
}

// 哈希色：名字 + agentId → HSL 主色
function colorFromHash(str, s = 0.62, l = 0.58) {
  const h = hashString(str) % 360
  return new THREE.Color().setHSL(h / 360, s, l)
}

// 构建一个 Q 版二头身化身（头 0.52 / 身体 0.5 + 呆毛 + 眼睛腮红 + 精灵伙伴 + 标签）
function makeAvatar(data) {
  const isExample = !!data.isExample
  const name = data.name || '旅行者'
  const role = data.role || '领主'
  const main = new THREE.Color(data.color || colorFromHash(name + (data.agentId || '')))
  const partnerColor = data.partnerColor || colorFromHash(name + '·伙伴', 0.7, 0.68)
  const toon = new THREE.MeshToonMaterial({ color: main })

  const g = new THREE.Group()
  g.userData = { isExample }

  // 身体（0.5 高）
  const body = new THREE.Mesh(roundedBox(0.52, 0.5, 0.38, 0.1), toon)
  body.position.y = 0.25
  g.add(body)
  // 头（略大 + 圆角）
  const head = new THREE.Mesh(roundedBox(0.52, 0.55, 0.52, 0.16), toon)
  head.position.y = 0.79
  g.add(head)
  // 呆毛
  const ahoge = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.24, 0.07),
    new THREE.MeshToonMaterial({ color: main.clone().multiplyScalar(1.3) })
  )
  ahoge.position.set(0, 1.14, -0.06)
  ahoge.rotation.z = 0.4
  g.add(ahoge)
  // 眼睛 + 腮红（可爱细节）
  const eyeMat = new THREE.MeshToonMaterial({ color: 0x3a2e24 })
  const eyeGeo = new THREE.BoxGeometry(0.08, 0.1, 0.03)
  const eL = new THREE.Mesh(eyeGeo, eyeMat); eL.position.set(-0.11, 0.82, 0.27); g.add(eL)
  const eR = new THREE.Mesh(eyeGeo, eyeMat); eR.position.set(0.11, 0.82, 0.27); g.add(eR)
  const blushMat = new THREE.MeshToonMaterial({ color: 0xff9fb4, transparent: true, opacity: 0.8 })
  const blushGeo = new THREE.BoxGeometry(0.1, 0.05, 0.02)
  const bL = new THREE.Mesh(blushGeo, blushMat); bL.position.set(-0.2, 0.7, 0.27); g.add(bL)
  const bR = new THREE.Mesh(blushGeo, blushMat); bR.position.set(0.2, 0.7, 0.27); g.add(bR)

  // 精灵伙伴（更小的方块 + 对比色 + 小翅膀）
  const partner = new THREE.Group()
  const pBody = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), new THREE.MeshToonMaterial({ color: partnerColor }))
  partner.add(pBody)
  const wingMat = new THREE.MeshToonMaterial({ color: 0xfff6e0, transparent: true, opacity: 0.85 })
  const wingGeo = new THREE.BoxGeometry(0.1, 0.16, 0.04)
  const wL = new THREE.Mesh(wingGeo, wingMat); wL.position.set(-0.19, 0.02, 0); partner.add(wL)
  const wR = new THREE.Mesh(wingGeo, wingMat); wR.position.set(0.19, 0.02, 0); partner.add(wR)
  partner.position.set(0.62, 0.45, 0.5)
  g.add(partner)

  // 头顶名字标签（名字 + 职业）
  const label = makeLabel(name, role, isExample)
  label.position.y = 1.62
  g.add(label)

  // 脚下软阴影（独立于群组，贴地面）
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 20),
    new THREE.MeshBasicMaterial({ color: 0x2b2018, transparent: true, opacity: 0.22, depthWrite: false })
  )
  shadow.rotation.x = -Math.PI / 2
  scene.add(shadow)

  scene.add(g)
  const rec = {
    group: g, shadow, partner,
    name, role, isExample,
    phase: Math.random() * Math.PI * 2,
    groundH: 8,
    baseYaw: Math.random() * Math.PI * 2,
    baseX: 0, baseZ: 0,
  }
  avatars.push(rec)
  if (isExample) exampleAvatars.push(rec)
  return rec
}

// 移除化身（API 数据到位后清掉示例）
function disposeAvatar(a) {
  scene.remove(a.group)
  scene.remove(a.shadow)
  const i = avatars.indexOf(a)
  if (i >= 0) avatars.splice(i, 1)
  const j = exampleAvatars.indexOf(a)
  if (j >= 0) exampleAvatars.splice(j, 1)
}

// 找出生点附近的地面落点（避开水面）
const SPAWN_SPOTS = [[5, 4], [9, -6], [4, 10], [-7, 5], [9, 12], [-10, -6], [13, 3], [-5, -11], [6, -12], [-13, 8]]
function findSpot(i) {
  const [ox, oz] = SPAWN_SPOTS[i % SPAWN_SPOTS.length]
  const j = Math.floor(i / SPAWN_SPOTS.length)
  const jx = (j % 5) * 22 + 2, jz = Math.floor(j / 5) * 22 + 2
  let x = ox + jx, z = oz + jz
  let guard = 0
  while (guard++ < 20 && (heightAt(x, z) <= SEA || Math.abs(z - streamZ(x)) < 3)) {
    x += 1.7; z += 1.3
  }
  return [x, z]
}

// 放置化身（API 数据 or 内置示例）
function placeAvatars(list) {
  for (let i = 0; i < list.length; i++) {
    const [x, z] = findSpot(i)
    const a = makeAvatar(list[i])
    a.baseX = x; a.baseZ = z
    a.groundH = heightAt(x, z) + 1
    a.group.position.set(x, a.groundH, z)
    a.group.rotation.y = a.baseYaw
  }
}

// 内置示例化身（API 不可用时的降级）
const EXAMPLE_AVATARS = [
  { name: '小星', role: '领主·田园', color: 0xff8fb0, isExample: true },
  { name: '阿土', role: '领主·农场', color: 0xe8a33d, isExample: true },
  { name: '咕噜', role: '领主·魔法', color: 0xb28dff, isExample: true },
]

function updateAvatars(t, dt) {
  for (const a of avatars) {
    // 待机：上下浮动 + 缓慢张望
    a.group.position.y = a.groundH + Math.sin(t * 1.7 + a.phase) * 0.07
    a.group.rotation.y = a.baseYaw + Math.sin(t * 0.55 + a.phase) * 0.4
    // 精灵伙伴：绕圈浮动
    a.partner.position.y = 0.45 + Math.sin(t * 2.4 + a.phase) * 0.09
    a.partner.rotation.y = t * 1.1 + a.phase
    // 软阴影贴地
    a.shadow.position.set(a.baseX, a.groundH + 0.02, a.baseZ)
  }
}

/* ============================ 5. 出生点装饰 ============================ */

// 领地高亮：8×8 半透明边界（对齐 mock 首块地契 x0:-4,z0:-4,x1:3,z1:3）
function buildDeedHighlight() {
  const x0 = -4, z0 = -4, x1 = 3, z1 = 3
  const cx = (x0 + x1 + 1) / 2, cz = (z0 + z1 + 1) / 2
  const y = heightAt(0, 0) + 1 + 0.06

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.26, depthWrite: false })
  )
  plane.rotation.x = -Math.PI / 2
  plane.position.set(cx, y, cz)
  plane.renderOrder = 1
  scene.add(plane)

  const borderGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(8, 8))
  const border = new THREE.LineSegments(
    borderGeo,
    new THREE.LineBasicMaterial({ color: 0x3a2e24, transparent: true, opacity: 0.6 })
  )
  border.rotation.x = -Math.PI / 2
  border.position.set(cx, y + 0.02, cz)
  scene.add(border)

  // 四角小木桩
  const postMat = new THREE.MeshToonMaterial({ color: 0xc9974f })
  for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.3), postMat)
    post.position.set(px + 0.5, heightAt(px, pz) + 1 + 0.35, pz + 0.5)
    scene.add(post)
  }
}

// 星门大桥进度标签（Sprite）
let bridgeLabel = null
function buildBridgeLabel() {
  const c = document.createElement('canvas')
  c.width = 340; c.height = 92
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  bridgeLabel = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  bridgeLabel.scale.set(3.4, 0.92, 1)
  bridgeLabel.position.set(0, 16, 12)
  scene.add(bridgeLabel)
  labelsToRedraw.push(() => drawBridgeLabel())
  drawBridgeLabel()
}
function drawBridgeLabel() {
  const pct = Math.round(bridgeProgress * 100)
  const ctx = bridgeLabel.material.map.image.getContext('2d')
  const c = bridgeLabel.material.map.image
  ctx.clearRect(0, 0, c.width, c.height)
  roundRectPath(ctx, 8, 8, c.width - 16, c.height - 16, 14)
  ctx.fillStyle = 'rgba(255,250,240,0.94)'; ctx.fill()
  ctx.lineWidth = 6; ctx.strokeStyle = '#3a2e24'; ctx.stroke()
  ctx.textAlign = 'center'
  ctx.fillStyle = '#3a2e24'
  ctx.font = '22px "ZCOOL KuaiLe", "Press Start 2P", sans-serif'
  ctx.fillText(`星门大桥 · 进度 ${pct}%`, c.width / 2, 34)
  // 迷你进度条
  ctx.fillStyle = '#3a2e24'
  ctx.fillRect(40, 52, c.width - 80, 14)
  ctx.fillStyle = '#6ec05a'
  ctx.fillRect(42, 54, (c.width - 84) * clamp(bridgeProgress, 0, 1), 10)
  bridgeLabel.material.map.needsUpdate = true
}

/* ============================ 6. 玩家操控与物理 ============================ */

const player = { x: 0.5, y: 9, z: 0.5, vx: 0, vy: 0, vz: 0, yaw: Math.PI + 0.15, pitch: -0.05, grounded: true }
const keys = {}
const input = { mx: 0, mz: 0, jump: false }
const pointers = new Map() // pointerId -> {kind:'stick'|'look', sx, sy, bx, by}

function setupControls() {
  const canvas = $('scene')
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  if (isTouch) { $('hint-desktop').classList.add('hidden'); $('hint-touch').classList.remove('hidden') }

  window.addEventListener('keydown', (e) => {
    keys[e.code] = true
    if (e.code === 'Space') { e.preventDefault(); input.jump = true }
  })
  window.addEventListener('keyup', (e) => { keys[e.code] = false })

  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  // 指针统一处理：鼠标拖拽环视 + 触屏左摇杆/右环视
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId)
    if (e.pointerType === 'touch') {
      if (e.clientX < window.innerWidth / 2) {
        pointers.set(e.pointerId, { kind: 'stick', bx: e.clientX, by: e.clientY, sx: e.clientX, sy: e.clientY })
      } else {
        pointers.set(e.pointerId, { kind: 'look', bx: e.clientX, by: e.clientY })
      }
    } else {
      pointers.set(e.pointerId, { kind: 'look', bx: e.clientX, by: e.clientY })
      canvas.classList.add('dragging')
    }
  })
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId)
    if (!p) return
    if (p.kind === 'look') {
      player.yaw -= (e.clientX - p.bx) * 0.0055
      player.pitch = clamp(player.pitch - (e.clientY - p.by) * 0.0055, -1.35, 1.35)
      p.bx = e.clientX; p.by = e.clientY
    } else if (p.kind === 'stick') {
      let dx = e.clientX - p.sx, dy = e.clientY - p.sy
      const len = Math.hypot(dx, dy)
      const maxR = 52
      if (len > maxR) { dx = (dx / len) * maxR; dy = (dy / len) * maxR }
      input.mx = dx / maxR
      input.mz = dy / maxR
    }
  })
  const endPointer = (e) => {
    const p = pointers.get(e.pointerId)
    if (p && p.kind === 'stick') { input.mx = 0; input.mz = 0 }
    pointers.delete(e.pointerId)
    if (pointers.size === 0) canvas.classList.remove('dragging')
  }
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)
}

// 列信息缓存（碰撞/落地每帧多次取高度，Map 有上限自动清空）
const heightCache = new Map()
function cachedInfo(x, z) {
  const k = Math.round(x) + ',' + Math.round(z)
  let v = heightCache.get(k)
  if (!v) {
    if (heightCache.size > 16384) heightCache.clear()
    v = columnInfo(Math.round(x), Math.round(z))
    heightCache.set(k, v)
  }
  return v
}

// 玩家可站立高度（地形表面 + 桥面 + 水晶/石柱，忽略树冠）
function standHeight(x, z) {
  const i = cachedInfo(x, z)
  let top = i.h + 1
  if (Math.abs(x) <= 6 && z >= 6 && z <= 18) {
    const d = bridgeDeckY(Math.round(x), Math.round(z))
    if (d !== null) top = Math.max(top, d + 1)
  }
  if (i.cr) top = Math.max(top, i.h + i.cr.h + 1)
  return top
}

function inWater(x, z, y) {
  return cachedInfo(x, z).h < SEA && y <= SEA + 0.6
}

// 简单 AABB 碰撞：横向移动撞到实心方块（树干/树叶/桥墩）则回退该轴
function collideMove(nx, nz) {
  const y0 = Math.floor(player.y + 0.1)
  const y1 = Math.floor(player.y + P_HEIGHT - 0.1)
  const solid = (x, z) => {
    for (let y = y0; y <= y1; y++) {
      const t = blockTypeAt(Math.round(x), y, Math.round(z))
      if (t && t !== 'water' && t !== 'flower') return true
    }
    return false
  }
  const tryMove = (x, z) => {
    if (solid(x - P_HALF, z - P_HALF)) return false
    if (solid(x + P_HALF, z - P_HALF)) return false
    if (solid(x - P_HALF, z + P_HALF)) return false
    if (solid(x + P_HALF, z + P_HALF)) return false
    return true
  }
  if (tryMove(nx, player.z)) player.x = nx
  if (tryMove(player.x, nz)) player.z = nz
}

function updatePlayer(dt) {
  // —— 输入合成：WASD / 方向键 + 虚拟摇杆 ——
  let mx = input.mx, mz = input.mz
  if (keys['KeyW'] || keys['ArrowUp']) mz += 1
  if (keys['KeyS'] || keys['ArrowDown']) mz -= 1
  if (keys['KeyA'] || keys['ArrowLeft']) mx -= 1
  if (keys['KeyD'] || keys['ArrowRight']) mx += 1
  const ml = Math.hypot(mx, mz)
  if (ml > 1) { mx /= ml; mz /= ml }

  // 相机朝向 → 移动方向（第一人称，前后/左右相对视角）
  const sinY = Math.sin(player.yaw), cosY = Math.cos(player.yaw)
  const fx = -sinY, fz = -cosY
  const rx = cosY, rz = -sinY
  const speed = inWater(player.x, player.z, player.y) ? SWIM_SPEED : WALK_SPEED
  const dx = (fx * mz + rx * mx) * speed * dt
  const dz = (fz * mz + rz * mx) * speed * dt
  collideMove(player.x + dx, player.z + dz)

  // —— 垂直：重力 + 跳跃 + 自动台阶/浮水 ——
  const sh = standHeight(player.x, player.z)
  const water = inWater(player.x, player.z, player.y)
  if (player.grounded) {
    if (input.jump) { player.vy = water ? 3.2 : JUMP_V; player.grounded = false }
  } else {
    player.vy -= GRAVITY * dt
    if (water && player.vy < -2) player.vy = -2
  }
  input.jump = false
  player.y += player.vy * dt

  if (water && !player.grounded) {
    player.y = lerp(player.y, SEA + 0.6, Math.min(1, dt * 2.5)) // 浮在水面
  }
  if (player.y <= sh + 0.001) {
    if (!player.grounded && sh - player.y < 1) { /* 落地 */ }
    player.y = sh
    player.vy = 0
    player.grounded = true
  } else if (sh - player.y < 0.62 && player.vy <= 0) {
    player.y = sh // 自动上台阶
    player.vy = 0
    player.grounded = true
  } else {
    player.grounded = false
  }
  if (player.y < 1) { player.y = 1; player.vy = 0 } // 兜底不穿底

  // —— 相机 ——
  camera.position.set(player.x, player.y + EYE, player.z)
  camera.rotation.set(player.pitch, player.yaw, 0)

  // —— HUD 坐标 ——
  $('coord-x').textContent = Math.round(player.x)
  $('coord-z').textContent = Math.round(player.z)
}

/* ============================ 7. 数据接缝（连接世界 API） ============================ */

/**
 * API 基地址：优先 window.ARIS_API_BASE，其次 URL ?api= 参数，最后默认生产地址。
 * 本地调试：window.ARIS_API_BASE = 'http://127.0.0.1:8787' 或打开 ?api=http://127.0.0.1:8787
 */
const API_DEFAULT = 'https://aris-kingdom-world.onrender.com/api/v1'
const ARIS_API_BASE = (window.ARIS_API_BASE || new URLSearchParams(location.search).get('api') || API_DEFAULT).replace(/\/+$/, '')

// API 基址探测：本地调试基址可能是裸端口（http://127.0.0.1:8787）而 mock 路径带 /api/v1 前缀。
// 用免鉴权的 /agents/recent 探测，缓存可用基址；生产基址已含 /api/v1 则跳过探测。
let apiBase = ARIS_API_BASE
let apiBaseChecked = false
let apiBasePromise = null
function resolveApiBase() {
  if (apiBaseChecked) return Promise.resolve(apiBase)
  if (apiBasePromise) return apiBasePromise
  if (/\/api\/v1\/?$/.test(ARIS_API_BASE)) { apiBaseChecked = true; return Promise.resolve(apiBase) }
  apiBasePromise = (async () => {
    for (const cand of [ARIS_API_BASE, ARIS_API_BASE + '/api/v1']) {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 3000)
        const res = await fetch(cand + '/agents/recent', { signal: ctrl.signal })
        clearTimeout(timer)
        if (res.ok) { apiBase = cand; break }
      } catch { /* 尝试下一个 */ }
    }
    return apiBase
  })().finally(() => { apiBasePromise = null; apiBaseChecked = true })
  return apiBasePromise
}

async function apiFetch(path, { method = 'GET', body, timeout = 5000 } = {}) {
  await resolveApiBase()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const headers = {}
    if (body) headers['content-type'] = 'application/json'
    const token = localStorage.getItem('aris_token')
    if (token) headers['authorization'] = 'Bearer ' + token
    const res = await fetch(apiBase + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const err = new Error(`API ${res.status} ${path}`)
      err.status = res.status
      throw err
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

let offlineMode = false

/**
 * GET /world/status —— 更新 HUD 与公共工程（星门大桥进度）。
 *
 * 契约 v0.2+（公开端点：GET/POST 均可、无需认证）：
 *   { ok, onlineAgents, claimedPlots, totalAgents,
 *     publicWorks:[{ id, name, status, progress:0-100, contributors, required, rewards }],
 *     featuredWork:{ name:'星门大桥', current, target },
 *     activeEvents:[...], weather }
 * HUD 读取：onlineAgents（在线数）、totalAgents（总数）、featuredWork.current/target（主进度条）。
 * 兼容旧形状：onlineCounts.agents / totalRealms / publicWorks[].progressPercent（0~1 或 0~100）。
 * 注：老式服务器只接受 POST /world/status，因此 GET 失败时自动重试 POST。
 */
async function loadWorldStatus() {
  let data
  try {
    data = await apiFetch('/world/status')
  } catch (e) {
    if (e.status === 405 || e.status === 404 || e.status === 401) {
      data = await apiFetch('/world/status', { method: 'POST', body: {} })
    } else {
      throw e
    }
  }
  const online = data.onlineCounts?.agents ?? data.onlineAgents
  const total = data.totalAgents
  const realms = data.totalRealms ?? data.claimedPlots
  updateHud({ online, total, realms })

  // 主进度条：优先 featuredWork（current/target），缺失时回退 publicWorks 里的桥
  let bridgeName = '星门大桥'
  let frac = null
  if (data.featuredWork && data.featuredWork.target > 0 && data.featuredWork.current !== undefined) {
    bridgeName = data.featuredWork.name || bridgeName
    frac = data.featuredWork.current / data.featuredWork.target
  } else {
    const works = data.publicWorks || []
    const bridge = works.find((w) => /bridge|桥/i.test((w.id || '') + (w.name || ''))) || works[0]
    if (bridge) {
      bridgeName = bridge.name || bridgeName
      const p = bridge.progressPercent ?? bridge.progress
      if (p !== undefined && p !== null) frac = p > 1 ? p / 100 : p
    }
  }
  if (frac !== null) setBridgeProgress(frac, bridgeName)

  const ev = (data.activeEvents || [])[0]
  if (ev && ev.title) {
    const chip = $('hud-event')
    chip.textContent = `✨ 事件 · ${ev.title}`
    chip.classList.remove('hidden')
  }
  return data
}

/**
 * GET /agents/recent —— 在世界放置最近活跃化身（公开端点，无需认证）。
 *
 * 预期响应：
 *   { agents:[ { agentId, name, role, personality:[...], lastActivity, favorites, lastSeen } ] }
 * role 如「领主·田园」；personality 数组（伙伴名/风格/声望）作为职业补充。
 * 最多取前 5 位；放真实名单前先清掉离线示例化身。
 */
async function loadAgents() {
  const data = await apiFetch('/agents/recent')
  const list = (data.agents || []).slice(0, 5)
  while (exampleAvatars.length) disposeAvatar(exampleAvatars[0]) // 放真实名单前先清示例化身
  placeAvatars(list.map((a) => ({
    agentId: a.agentId,
    name: a.name,
    role: a.role || '领主',
    tags: a.personality || [],
    isExample: false,
  })))
  return data
}

/**
 * POST /agents/enter —— 玩家入场登记（可选），返回后更新 HUD 领主编号/星币。
 *
 * 预期响应（mock enterResponse）：
 *   { ok:true, agentId, token, lordNumber, welcome, position:{x,y,z},
 *     realmStatus, partner:{name}, wallet, inventory }
 * 请求体：{ action:'enter', name, personality, passport:{ publicKey } }
 */
async function enterWorld(name) {
  let pk = localStorage.getItem('aris_pk')
  if (!pk) { pk = 'pk_' + Math.random().toString(16).slice(2, 10); localStorage.setItem('aris_pk', pk) }
  const data = await apiFetch('/agents/enter', {
    method: 'POST',
    body: {
      action: 'enter',
      name: name || localStorage.getItem('aris_name') || `旅行者${Math.floor(Math.random() * 900 + 100)}`,
      personality: ['田园', '喜欢照料麦田'],
      passport: { publicKey: pk },
    },
  })
  if (data.token) localStorage.setItem('aris_token', data.token)
  updateHud({ lord: data.lordNumber, coins: data.wallet })
  if (data.partner?.name && data.welcome) toast(`${data.welcome}`)
  else if (data.welcome) toast(data.welcome)
  else toast(`入场成功！你是第 ${data.lordNumber ?? '—'} 位领主`)
  // 入场成功 → 在线：隐藏离线徽章，拉取世界状态与真实化身名单（示例化身会被替换）
  offlineMode = false
  $('offline-badge').classList.add('hidden')
  loadWorldStatus().catch(() => {})
  loadAgents().catch(() => {})
  return data
}

// 初始接缝调用：全部失败 → 离线漫游（内置示例化身 + 徽章），绝不抛未捕获错误
async function bootstrapApi() {
  const results = await Promise.allSettled([loadWorldStatus(), loadAgents()])
  const anyFail = results.some((r) => r.status === 'rejected')
  if (anyFail) {
    offlineMode = true
    $('offline-badge').classList.remove('hidden')
    if (avatars.length === 0) placeAvatars(EXAMPLE_AVATARS) // 离线兜底：至少 3 个示例化身
  }
  console.info('[world-viz] 数据接缝结果:', results.map((r) => r.status))
}

/* ============================ 8. HUD ============================ */

const hudState = { lord: null, coins: null, online: null, total: null, realms: null }
function updateHud(patch) {
  Object.assign(hudState, patch)
  if (hudState.lord !== null) $('hud-lord').textContent = fmt(hudState.lord)
  if (hudState.coins !== null) $('hud-coins').textContent = fmt(hudState.coins)
  if (hudState.online !== null) $('hud-online').textContent = fmt(hudState.online)
  if (hudState.total !== null) $('hud-total').textContent = fmt(hudState.total)
  if (hudState.realms !== null) $('hud-realms').textContent = fmt(hudState.realms)
}

function setBridgeProgress(frac, name) {
  bridgeProgress = clamp(frac, 0, 1)
  if (name) $('hud-bridge-name').textContent = name
  $('hud-bridge-bar').style.width = Math.round(bridgeProgress * 100) + '%'
  $('hud-bridge-pct').textContent = Math.round(bridgeProgress * 100) + '%'
  drawBridgeLabel()
  rebuildAllChunks() // 桥面木板/拱门随进度重建
}

let toastTimer = 0
function toast(msg) {
  const el = $('welcome-toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 6000)
}

function showFatal(err) {
  console.error('[world-viz] 初始化失败:', err)
  const el = $('fatal')
  el.classList.remove('hidden')
  el.innerHTML = `<div class="fatal-card">世界生成失败：${String(err?.message || err)}<br/><br/>请刷新重试。</div>`
  $('loading').classList.add('done')
}

/* ============================ 9. 主循环 ============================ */

const clock = new THREE.Clock()
let lastChunkCheck = 0
let firstFrame = true

function loop() {
  requestAnimationFrame(loop)
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  updatePlayer(dt)

  // 区块流式（节流 0.3s 检查一次）
  if (t - lastChunkCheck > 0.3) {
    lastChunkCheck = t
    updateChunks(false)
  }

  updateAvatars(t, dt)

  // 云缓慢飘动 + 环绕
  for (const c of clouds) {
    c.position.x += c.userData.speed * dt
    if (c.position.x > 380) c.position.x = -380
  }

  // 粒子围绕玩家漂移
  const px = player.x, pz = player.z
  for (let i = 0; i < particlePos.length / 3; i++) {
    const i3 = i * 3
    if (Math.abs(particlePos[i3] - px) > 60 || Math.abs(particlePos[i3 + 2] - pz) > 60) {
      particlePos[i3] = px + (Math.random() - 0.5) * 120
      particlePos[i3 + 2] = pz + (Math.random() - 0.5) * 120
      particlePos[i3 + 1] = 2 + Math.random() * 34
      particleSeed[i3] = particlePos[i3]; particleSeed[i3 + 2] = particlePos[i3 + 2]
    }
    particlePos[i3 + 1] = particleSeed[i3 + 1] + Math.sin(t * 0.8 + i) * 1.6
    particlePos[i3] = particleSeed[i3] + Math.sin(t * 0.45 + i * 1.7) * 1.4
    particlePos[i3 + 2] = particleSeed[i3 + 2] + Math.cos(t * 0.4 + i * 1.3) * 1.4
  }
  particlePoints.geometry.attributes.position.needsUpdate = true

  // 天空穹顶跟随相机
  skyDome.position.copy(camera.position)

  SHARED_UNIFORMS.uTime.value = t
  renderer.render(scene, camera)

  if (firstFrame) {
    firstFrame = false
    $('loading').classList.add('done')
  }
}

/* ============================ 10. 启动 ============================ */

async function init() {
  setupScene()
  updateChunks(true) // 初始生成视距内所有区块（内部已增量重建）
  placeAvatars(EXAMPLE_AVATARS) // 先放示例化身，API 成功后替换为真实名单
  setupControls()
  $('enter-btn').addEventListener('click', () => {
    const btn = $('enter-btn')
    btn.disabled = true
    btn.textContent = '登记中…'
    enterWorld()
      .catch((e) => { offlineMode = true; $('offline-badge').classList.remove('hidden'); toast('入场登记失败，已进入离线漫游') })
      .finally(() => { btn.disabled = false; btn.textContent = '入场登记' })
  })
  bootstrapApi() // 不阻塞世界渲染；失败自动降级
  document.fonts?.ready.then(() => { for (const fn of labelsToRedraw) fn() }).catch(() => {})
  loop()
}

init().catch(showFatal)

// 只读调试钩子（供自动化测试/控制台查看渲染统计，不参与游戏逻辑）
window.__ARIS_WORLD = {
  get renderInfo() { return renderer ? renderer.info.render : null },
  get stats() {
    return {
      chunks: chunks.size,
      meshes: chunkMeshes.size * 2,
      avatars: avatars.length,
      bridge: bridgeProgress,
      offline: offlineMode,
      player: { x: Math.round(player.x), y: Math.round(player.y), z: Math.round(player.z) },
    }
  },
}

/* ============================================================================
 * TODO / 已知限制
 *  - 每区块实例容量固定（OPQ_CAP 4096 / WAT_CAP 768），极端地形可能截断（有 warn）
 *  - 世界无限延伸，但 JS 坐标精度在 ±10^7 后可能出现接缝（可接受范围）
 *  - 无实时阴影：用伪 AO（顶/侧/底亮度差）代替，风格化更可爱
 *  - 无昼夜循环 / 第三人称 / 音效：见设计规范「下一步」
 *  - 真实世界服 WS 事件（/ws）未接入：公共工程进度靠轮询 /world/status
 * ========================================================================== */
