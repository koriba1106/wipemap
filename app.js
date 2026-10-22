import { VectorTile } from 'https://esm.sh/@mapbox/vector-tile@1.3.1';
import Pbf from 'https://esm.sh/pbf@3.2.1';

/* =========================================================================
   1. 定数・テーマ定義・ホワイトリスト
   ========================================================================= */
const APP_SCHEMA_VERSION = '1.0.0';
const STORAGE_AUTOSAVE_KEY = 'wipemap_studio_pro_autosave_v1';
const SVG_W = 800;
const SVG_H = 500;

const VALID_PRESETS = new Set(['outline', 'callout', 'numbered', 'station', 'ribbon', 'wood', 'badge']);
const VALID_ANIM_TYPES = new Set(['pulse', 'bounce', 'walk', 'star', 'heart', 'compass', 'flag']);
const VALID_ROUTE_STYLES = new Set(['dashed', 'solid', 'dots']);
const VALID_ROUTE_CURVES = new Set(['catmull', 'linear']);
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

const THEMES = Object.freeze({
  'tv-ivory': {
    transparent: false,
    land: '#f6f5f0',
    water: '#a8d8f8',
    waterStroke: '#6eb4e6',
    majorRoad: '#fde047',
    majorCase: '#d97706',
    minorRoad: '#ffffff',
    minorCase: '#d1cfc9',
    border: '#94a3b8',
    railBase: '#475569',
    railDash: '#ffffff'
  },
  'soft-gray': {
    transparent: false,
    land: '#f3f4f6',
    water: '#cbd5e1',
    waterStroke: '#94a3b8',
    majorRoad: '#ffffff',
    majorCase: '#64748b',
    minorRoad: '#f8fafc',
    minorCase: '#cbd5e1',
    border: '#9ca3af',
    railBase: '#475569',
    railDash: '#ffffff'
  },
  'pastel-walk': {
    transparent: false,
    land: '#fef9f5',
    water: '#bae6fd',
    waterStroke: '#7dd3fc',
    majorRoad: '#fed7aa',
    majorCase: '#ea580c',
    minorRoad: '#ffffff',
    minorCase: '#e5e7eb',
    border: '#a1a1aa',
    railBase: '#52525b',
    railDash: '#ffffff'
  },
  'retro-map': {
    transparent: false,
    land: '#efe8d8',
    water: '#9bc1bc',
    waterStroke: '#6b9ac4',
    majorRoad: '#f4a261',
    majorCase: '#8d5b4c',
    minorRoad: '#faf6f0',
    minorCase: '#cbbca6',
    border: '#8c7a6b',
    railBase: '#5c4d42',
    railDash: '#efe8d8'
  },
  'line-trans-dark': {
    transparent: true,
    land: 'none',
    water: 'none',
    waterStroke: '#0284c7',
    majorRoad: '#1f2937',
    majorCase: '#ffffff',
    minorRoad: '#4b5563',
    minorCase: '#ffffff',
    border: '#64748b',
    railBase: '#111827',
    railDash: '#ffffff'
  },
  'line-trans-light': {
    transparent: true,
    land: 'none',
    water: 'none',
    waterStroke: '#38bdf8',
    majorRoad: '#ffffff',
    majorCase: '#1f2937',
    minorRoad: '#f3f4f6',
    minorCase: '#374151',
    border: '#cbd5e1',
    railBase: '#ffffff',
    railDash: '#1f2937'
  }
});

/* =========================================================================
   2. メモリ管理・通信堅牢性モジュール (LRU Cache + 並列制限 + Timeout)
   ========================================================================= */
class TileCacheLRU {
  constructor(limit = 64) {
    this.limit = limit;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, val);
  }
}

const tileCache = new TileCacheLRU(64);
let currentAbortController = null;

async function fetchTileWithTimeout(url, signal, timeoutMs = 8000) {
  const cached = tileCache.get(url);
  if (cached) return cached;

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
  const onParentAbort = () => timeoutCtrl.abort();
  signal.addEventListener('abort', onParentAbort, { once: true });

  try {
    const res = await fetch(url, { signal: timeoutCtrl.signal });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    tileCache.set(url, buf);
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onParentAbort);
  }
}

async function runWithConcurrency(tasks, concurrency = 6) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const cur = index++;
      results[cur] = await tasks[cur]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/* =========================================================================
   3. アプリケーション初期状態 ＆ 状態管理
   ========================================================================= */
function createDefaultProjectState() {
  return {
    theme: 'tv-ivory',
    layers: {
      coast: true,
      border: true,
      majorRoad: true,
      minorRoad: true,
      bridge: true,
      rail: true
    },
    mapRegion: {
      south: 34.805,
      west: 135.332,
      north: 34.825,
      east: 135.360,
      zoom: 15
    },
    eraser: {
      size: 32,
      strokes: []
    },
    labels: [
      { id: 'lbl-1', x: 235, y: 155, text: 'スタート地点', sub: '①', preset: 'numbered', color: '#dc2626', size: 18, rot: 0 },
      { id: 'lbl-2', x: 420, y: 245, text: '名物商店街', sub: '散策', preset: 'callout', color: '#2563eb', size: 17, rot: 0 },
      { id: 'lbl-3', x: 585, y: 195, text: '大橋展望スポット', sub: '絶景', preset: 'ribbon', color: '#059669', size: 18, rot: 0 }
    ],
    routePoints: [
      [235, 185], [315, 225], [420, 265], [510, 235], [585, 215]
    ],
    routeConfig: {
      style: 'dashed',
      curve: 'catmull',
      color: '#ef4444',
      width: 6
    },
    animConfig: {
      animType: 'pulse',
      speed: 1.0
    }
  };
}

const defaults = createDefaultProjectState();

const state = {
  tool: 'select', // 'select' | 'add-label' | 'draw-route' | 'eraser'
  theme: defaults.theme,
  layers: { ...defaults.layers },
  mapRegion: { ...defaults.mapRegion },
  mapGeoData: null,
  eraser: {
    size: defaults.eraser.size,
    strokes: []
  },
  labels: structuredClone(defaults.labels),
  selectedLabelId: 'lbl-1',
  routePoints: structuredClone(defaults.routePoints),
  routeConfig: { ...defaults.routeConfig },
  playback: {
    playing: false,
    recording: false,
    cancelRecordingRequested: false,
    progress: 1.0,
    animTimeSec: 0,
    animType: defaults.animConfig.animType,
    speed: defaults.animConfig.speed,
    rafId: null,
    lastTimestamp: 0
  }
};

/* =========================================================================
   4. トースト通知 ＆ ステータス表示ユーティリティ
   ========================================================================= */
function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const item = document.createElement('div');
  item.className = `toast-item${isError ? ' error' : ''}`;
  item.textContent = message;
  container.appendChild(item);

  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transition = 'opacity 0.25s ease';
    setTimeout(() => item.remove(), 260);
  }, 3200);
}

function setHudStatus(msg, busy = false) {
  const textEl = document.getElementById('hud-text');
  const dotEl = document.getElementById('hud-dot');
  if (textEl) textEl.textContent = msg;
  if (dotEl) dotEl.classList.toggle('busy', Boolean(busy));
}

/* =========================================================================
   5. プロジェクト保存・読込・厳格スキーマ検証サニタイザー (Production-Grade)
   ========================================================================= */
function clampNumber(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeColor(val, fallback) {
  return typeof val === 'string' && HEX_COLOR_REGEX.test(val.trim()) ? val.trim() : fallback;
}

function sanitizeString(val, maxLen, fallback = '') {
  if (typeof val !== 'string') return fallback;
  return val.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

/**
 * 外部JSONペイロードを検証・サニタイズし、安全なプロジェクトオブジェクトを返す
 */
function sanitizeProjectPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('プロジェクトファイルの形式が正しくありません。');
  }

  const def = createDefaultProjectState();
  const theme = Object.prototype.hasOwnProperty.call(THEMES, raw.theme) ? raw.theme : def.theme;

  // レイヤー設定の検証
  const rawLayers = (raw.layers && typeof raw.layers === 'object') ? raw.layers : {};
  const layers = {
    coast: rawLayers.coast !== undefined ? Boolean(rawLayers.coast) : def.layers.coast,
    border: rawLayers.border !== undefined ? Boolean(rawLayers.border) : def.layers.border,
    majorRoad: rawLayers.majorRoad !== undefined ? Boolean(rawLayers.majorRoad) : def.layers.majorRoad,
    minorRoad: rawLayers.minorRoad !== undefined ? Boolean(rawLayers.minorRoad) : def.layers.minorRoad,
    bridge: rawLayers.bridge !== undefined ? Boolean(rawLayers.bridge) : def.layers.bridge,
    rail: rawLayers.rail !== undefined ? Boolean(rawLayers.rail) : def.layers.rail
  };

  // 地図領域の検証（日本国内外の有効な経緯度範囲）
  const rm = (raw.mapRegion && typeof raw.mapRegion === 'object') ? raw.mapRegion : {};
  const south = clampNumber(rm.south, -85, 85, def.mapRegion.south);
  const north = clampNumber(rm.north, -85, 85, def.mapRegion.north);
  const west = clampNumber(rm.west, -180, 180, def.mapRegion.west);
  const east = clampNumber(rm.east, -180, 180, def.mapRegion.east);
  const mapRegion = {
    south: Math.min(south, north - 0.0005),
    north: Math.max(north, south + 0.0005),
    west: Math.min(west, east - 0.0005),
    east: Math.max(east, west + 0.0005),
    zoom: Math.round(clampNumber(rm.zoom, 5, 18, def.mapRegion.zoom))
  };

  // 消しゴム履歴の検証（最大500ストローク、各ストローク最大2000頂点）
  const rawEraser = (raw.eraser && typeof raw.eraser === 'object') ? raw.eraser : {};
  const eraserSize = Math.round(clampNumber(rawEraser.size, 8, 120, def.eraser.size));
  const strokes = [];
  if (Array.isArray(rawEraser.strokes)) {
    for (const st of rawEraser.strokes.slice(0, 500)) {
      if (!st || typeof st !== 'object' || !Array.isArray(st.points)) continue;
      const stSize = Math.round(clampNumber(st.size, 8, 120, 32));
      const pts = [];
      for (const p of st.points.slice(0, 2000)) {
        if (Array.isArray(p) && p.length >= 2) {
          pts.push([
            Math.round(clampNumber(p[0], -100, SVG_W + 100, 0)),
            Math.round(clampNumber(p[1], -100, SVG_H + 100, 0))
          ]);
        }
      }
      if (pts.length > 0) strokes.push({ size: stSize, points: pts });
    }
  }

  // ラベル一覧の検証（最大150件）
  const labels = [];
  if (Array.isArray(raw.labels)) {
    raw.labels.slice(0, 150).forEach((lbl, idx) => {
      if (!lbl || typeof lbl !== 'object') return;
      labels.push({
        id: sanitizeString(lbl.id, 40, `lbl-${Date.now()}-${idx}`) || `lbl-${idx}`,
        x: Math.round(clampNumber(lbl.x, 10, SVG_W - 10, SVG_W / 2)),
        y: Math.round(clampNumber(lbl.y, 10, SVG_H - 10, SVG_H / 2)),
        text: sanitizeString(lbl.text, 40, 'スポット'),
        sub: sanitizeString(lbl.sub, 6, ''),
        preset: VALID_PRESETS.has(lbl.preset) ? lbl.preset : 'outline',
        color: sanitizeColor(lbl.color, '#1f2937'),
        size: Math.round(clampNumber(lbl.size, 11, 38, 18)),
        rot: Math.round(clampNumber(lbl.rot, -45, 45, 0))
      });
    });
  }

  // 散策ルートの検証（最大1000頂点）
  const routePoints = [];
  if (Array.isArray(raw.routePoints)) {
    for (const pt of raw.routePoints.slice(0, 1000)) {
      if (Array.isArray(pt) && pt.length >= 2) {
        routePoints.push([
          Math.round(clampNumber(pt[0], 5, SVG_W - 5, SVG_W / 2)),
          Math.round(clampNumber(pt[1], 5, SVG_H - 5, SVG_H / 2))
        ]);
      }
    }
  }

  const rc = (raw.routeConfig && typeof raw.routeConfig === 'object') ? raw.routeConfig : {};
  const routeConfig = {
    style: VALID_ROUTE_STYLES.has(rc.style) ? rc.style : def.routeConfig.style,
    curve: VALID_ROUTE_CURVES.has(rc.curve) ? rc.curve : def.routeConfig.curve,
    color: sanitizeColor(rc.color, def.routeConfig.color),
    width: Math.round(clampNumber(rc.width, 3, 12, def.routeConfig.width))
  };

  const ac = (raw.animConfig && typeof raw.animConfig === 'object') ? raw.animConfig : {};
  const animConfig = {
    animType: VALID_ANIM_TYPES.has(ac.animType) ? ac.animType : def.animConfig.animType,
    speed: clampNumber(ac.speed, 0.2, 5.0, def.animConfig.speed)
  };

  return {
    version: APP_SCHEMA_VERSION,
    theme,
    layers,
    mapRegion,
    eraser: { size: eraserSize, strokes },
    labels,
    routePoints,
    routeConfig,
    animConfig
  };
}

/**
 * 現在のアプリ状態をシリアライズ用オブジェクトに変換
 */
function serializeCurrentProject() {
  return {
    app: 'WipeMap Studio Pro',
    version: APP_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    theme: state.theme,
    layers: { ...state.layers },
    mapRegion: { ...state.mapRegion },
    eraser: {
      size: state.eraser.size,
      strokes: state.eraser.strokes
    },
    labels: state.labels,
    routePoints: state.routePoints,
    routeConfig: { ...state.routeConfig },
    animConfig: {
      animType: state.playback.animType,
      speed: state.playback.speed
    }
  };
}

/**
 * 自動保存（デバウンス付き localStorage 保存）
 */
let autoSaveTimer = null;
function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try {
      const payload = serializeCurrentProject();
      localStorage.setItem(STORAGE_AUTOSAVE_KEY, JSON.stringify(payload));
    } catch {
      // プライベートブラウジングや容量超過時は無視
    }
  }, 400);
}

/**
 * 検証済みプロジェクトデータをStateとUIコントロール一式へ反映
 */
async function applyProjectData(cleanData, fetchMap = true) {
  stopPlayback();

  state.theme = cleanData.theme;
  state.layers = { ...cleanData.layers };
  state.mapRegion = { ...cleanData.mapRegion };
  state.eraser.size = cleanData.eraser.size;
  state.eraser.strokes = structuredClone(cleanData.eraser.strokes);
  state.labels = structuredClone(cleanData.labels);
  state.selectedLabelId = state.labels[0]?.id || null;
  state.routePoints = structuredClone(cleanData.routePoints);
  state.routeConfig = { ...cleanData.routeConfig };
  state.playback.animType = cleanData.animConfig.animType;
  state.playback.speed = cleanData.animConfig.speed;
  state.playback.progress = 1.0;

  syncAllUiControlsFromState();
  renderEraserMask();
  renderLabelsLayer();
  renderRouteAndMarker();

  if (fetchMap) {
    const bounds = L.latLngBounds(
      [state.mapRegion.south, state.mapRegion.west],
      [state.mapRegion.north, state.mapRegion.east]
    );
    await extractVectorMapFromBounds(bounds, state.mapRegion.zoom);
  } else {
    renderMapVectorLayer();
  }
  scheduleAutoSave();
}

function syncAllUiControlsFromState() {
  // テーマとレイヤーボタン
  document.getElementById('theme-select').value = state.theme;
  document.querySelectorAll('#layer-toggles .layer-pill').forEach(pill => {
    const key = pill.dataset.layer;
    pill.classList.toggle('active', Boolean(state.layers[key]));
  });

  // 消しゴムUI
  document.getElementById('eraser-size').value = state.eraser.size;
  document.getElementById('eraser-size-val').textContent = `${state.eraser.size}px`;
  eraserCursor.attr('r', state.eraser.size / 2);

  // ルート設定UI
  document.getElementById('route-style').value = state.routeConfig.style;
  document.getElementById('route-curve').value = state.routeConfig.curve;
  document.getElementById('route-color').value = state.routeConfig.color;
  document.getElementById('route-width').value = state.routeConfig.width;
  document.getElementById('route-width-val').textContent = `${state.routeConfig.width}px`;

  // アニメーション設定UI
  document.getElementById('anim-type-select').value = state.playback.animType;
  document.getElementById('anim-speed-select').value = String(state.playback.speed);
  document.getElementById('route-progress').value = Math.round(state.playback.progress * 1000);

  // 選択中ラベルUI
  if (state.selectedLabelId) {
    selectLabel(state.selectedLabelId);
  }
}

/* =========================================================================
   6. SVGレイヤー＆非破壊消しゴムマスク構造の初期化
   ========================================================================= */
const svg = d3.select('#wipe-svg');
const defs = svg.append('defs');

// 消しゴム用SVGマスク（白＝表示、黒＝消去）
const eraserMask = defs.append('mask')
  .attr('id', 'eraser-mask')
  .attr('maskUnits', 'userSpaceOnUse')
  .attr('x', 0).attr('y', 0).attr('width', SVG_W).attr('height', SVG_H);

eraserMask.append('rect')
  .attr('x', 0).attr('y', 0)
  .attr('width', SVG_W).attr('height', SVG_H)
  .attr('fill', '#ffffff');

const gEraserStrokes = eraserMask.append('g').attr('id', 'eraser-strokes-group');

const gBaseBg = svg.append('rect')
  .attr('id', 'layer-base-bg')
  .attr('width', SVG_W)
  .attr('height', SVG_H)
  .attr('fill', THEMES[state.theme].land);

const gMapVector = svg.append('g')
  .attr('id', 'layer-map-vector')
  .attr('mask', 'url(#eraser-mask)');

const gRoute = svg.append('g').attr('id', 'layer-route');
const gLabels = svg.append('g').attr('id', 'layer-labels');
const gMarker = svg.append('g').attr('id', 'layer-current-marker');
const gCredit = svg.append('g').attr('id', 'layer-credit');
const gUiOverlay = svg.append('g').attr('id', 'layer-ui-overlay');

const eraserCursor = gUiOverlay.append('circle')
  .attr('class', 'eraser-cursor')
  .attr('r', state.eraser.size / 2)
  .attr('cx', -200)
  .attr('cy', -200)
  .style('display', 'none');

// 国土地理院クレジット表記
gCredit.append('rect')
  .attr('x', SVG_W - 108).attr('y', SVG_H - 24)
  .attr('width', 100).attr('height', 18).attr('rx', 4)
  .attr('fill', 'rgba(255,255,255,0.78)');
gCredit.append('text')
  .attr('x', SVG_W - 58).attr('y', SVG_H - 11)
  .attr('text-anchor', 'middle').attr('font-size', '10px').attr('fill', '#4b5563').attr('font-weight', '600')
  .text('出典：国土地理院');

/* =========================================================================
   7. 国土地理院 最適化ベクトルタイル抽出・レンダリング
   ========================================================================= */
function lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2tile(lat, z) {
  return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
}

function getOptimalTileConfig(mapZoom) {
  if (mapZoom <= 11) return { tileZoom: Math.max(8, Math.min(11, mapZoom)), label: `広域・島全体モード (Z:${mapZoom})` };
  if (mapZoom <= 14) return { tileZoom: mapZoom, label: `中域・市区モード (Z:${mapZoom})` };
  return { tileZoom: 16, label: `詳細・街歩きモード (Z:16)` };
}

async function extractVectorMapFromBounds(bounds, mapZoom) {
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  setHudStatus('国土地理院ベクトルタイルを取得・線画化しています...', true);

  const minLng = bounds.getWest(), maxLng = bounds.getEast();
  const minLat = bounds.getSouth(), maxLat = bounds.getNorth();

  // プロジェクト保存用に現在の地図範囲を記録
  state.mapRegion = {
    south: Number(minLat.toFixed(6)),
    west: Number(minLng.toFixed(6)),
    north: Number(maxLat.toFixed(6)),
    east: Number(maxLng.toFixed(6)),
    zoom: mapZoom
  };
  scheduleAutoSave();

  const { tileZoom, label } = getOptimalTileConfig(mapZoom);
  document.getElementById('scale-indicator').textContent = label;

  let activeZoom = tileZoom;
  let minX = lon2tile(minLng, activeZoom), maxX = lon2tile(maxLng, activeZoom);
  let minY = lat2tile(maxLat, activeZoom), maxY = lat2tile(minLat, activeZoom);

  while ((maxX - minX + 1) * (maxY - minY + 1) > 25 && activeZoom > 8) {
    activeZoom--;
    minX = lon2tile(minLng, activeZoom);
    maxX = lon2tile(maxLng, activeZoom);
    minY = lat2tile(maxLat, activeZoom);
    maxY = lat2tile(minLat, activeZoom);
  }

  const tasks = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const url = `https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${activeZoom}/${x}/${y}.pbf`;
      tasks.push(async () => {
        const buf = await fetchTileWithTimeout(url, signal);
        return buf ? { x, y, buf } : null;
      });
    }
  }

  const rawTiles = (await runWithConcurrency(tasks, 6)).filter(Boolean);
  if (signal.aborted) return;

  const categorized = {
    waterArea: [],
    coastline: [],
    borders: [],
    majorRoads: [],
    minorRoads: [],
    bridges: [],
    railways: [],
    poiLabels: []
  };

  for (const { x, y, buf } of rawTiles) {
    let tile;
    try {
      tile = new VectorTile(new Pbf(buf));
    } catch {
      continue;
    }
    for (const layerName of Object.keys(tile.layers)) {
      const layer = tile.layers[layerName];
      const ln = layerName.toLowerCase();
      for (let i = 0; i < layer.length; i++) {
        const feat = layer.feature(i);
        const props = feat.properties || {};
        const geo = feat.toGeoJSON(x, y, activeZoom);

        if (ln.includes('wa') || ln.includes('water') || ln.includes('coastline') || ln.includes('rvrcl') || ln.includes('wl')) {
          if (geo.geometry.type.includes('Polygon')) categorized.waterArea.push(geo);
          else categorized.coastline.push(geo);
        } else if (ln.includes('bnd') || ln.includes('adm')) {
          categorized.borders.push(geo);
        } else if (ln.includes('rdcl') || ln.includes('road')) {
          const rdCtg = props.rdCtg ?? props.ftCode;
          const isBridge = (props.state === '橋・高架' || props.state === 1 || props.ftCode === 2703);
          if (isBridge && activeZoom >= 14) categorized.bridges.push(geo);

          const isMajor = activeZoom <= 13 || rdCtg === 0 || rdCtg === 1 ||
                          String(props.rdCtg).includes('国道') || String(props.rdCtg).includes('県道') ||
                          String(props.rdCtg).includes('高速');
          if (isMajor) categorized.majorRoads.push(geo);
          else categorized.minorRoads.push(geo);
        } else if (ln.includes('rail')) {
          categorized.railways.push(geo);
        } else if ((ln.includes('label') || ln.includes('anno') || ln.includes('structure')) && geo.geometry.type === 'Point') {
          const name = props.knj || props.name || props.dspName;
          if (typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 12) {
            categorized.poiLabels.push({
              name: name.trim(),
              coords: geo.geometry.coordinates,
              isStation: String(props.annoCtg || '').includes('駅') || name.endsWith('駅')
            });
          }
        }
      }
    }
  }

  const projection = d3.geoMercator().fitExtent([[12, 12], [SVG_W - 12, SVG_H - 12]], {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [minLng, minLat] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [maxLng, maxLat] } }
    ]
  });

  state.mapGeoData = { categorized, projection };
  renderMapVectorLayer();
  setHudStatus(`線画生成完了（幹線:${categorized.majorRoads.length} / 街路:${categorized.minorRoads.length} / 橋:${categorized.bridges.length}）`, false);
}

function renderMapVectorLayer() {
  const theme = THEMES[state.theme] || THEMES['tv-ivory'];
  const wipeFrame = document.getElementById('wipe-frame');

  if (theme.transparent) {
    gBaseBg.attr('fill', 'none').attr('opacity', 0);
    wipeFrame.classList.add('transparent-checker');
  } else {
    gBaseBg.attr('fill', theme.land).attr('opacity', 1);
    wipeFrame.classList.remove('transparent-checker');
  }

  gMapVector.selectAll('*').remove();
  if (!state.mapGeoData) return;

  const { categorized, projection } = state.mapGeoData;
  const path = d3.geoPath().projection(projection);

  if (state.layers.coast) {
    gMapVector.append('g').selectAll('path')
      .data(categorized.waterArea).enter().append('path')
      .attr('d', path)
      .attr('fill', theme.transparent ? 'none' : theme.water)
      .attr('stroke', theme.waterStroke)
      .attr('stroke-width', theme.transparent ? 1.8 : 1);

    gMapVector.append('g').selectAll('path')
      .data(categorized.coastline).enter().append('path')
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', theme.waterStroke)
      .attr('stroke-width', 2.2)
      .attr('stroke-linecap', 'round');
  }

  if (state.layers.border) {
    gMapVector.append('g').selectAll('path')
      .data(categorized.borders).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', theme.border)
      .attr('stroke-width', 1.4).attr('stroke-dasharray', '6,4');
  }

  if (state.layers.minorRoad) {
    const gMinor = gMapVector.append('g');
    gMinor.selectAll('.c').data(categorized.minorRoads).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', theme.minorCase)
      .attr('stroke-width', 4).attr('stroke-linecap', 'round');
    gMinor.selectAll('.r').data(categorized.minorRoads).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', theme.minorRoad)
      .attr('stroke-width', 2.2).attr('stroke-linecap', 'round');
  }

  if (state.layers.majorRoad) {
    const gMajor = gMapVector.append('g');
    gMajor.selectAll('.c').data(categorized.majorRoads).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', theme.majorCase)
      .attr('stroke-width', 5.8).attr('stroke-linecap', 'round');
    gMajor.selectAll('.r').data(categorized.majorRoads).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', theme.majorRoad)
      .attr('stroke-width', 3.4).attr('stroke-linecap', 'round');
  }

  if (state.layers.bridge) {
    const gBridge = gMapVector.append('g');
    gBridge.selectAll('.b-rail').data(categorized.bridges).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', '#334155')
      .attr('stroke-width', 7.5).attr('stroke-linecap', 'butt');
    gBridge.selectAll('.b-deck').data(categorized.bridges).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', '#ffffff')
      .attr('stroke-width', 4.2).attr('stroke-linecap', 'butt');
  }

  if (state.layers.rail) {
    const gRail = gMapVector.append('g');
    gRail.selectAll('.rb').data(categorized.railways).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', theme.railBase).attr('stroke-width', 3.2);
    gRail.selectAll('.rd').data(categorized.railways).enter().append('path')
      .attr('d', path).attr('fill', 'none').attr('stroke', theme.railDash).attr('stroke-width', 1.8)
      .attr('stroke-dasharray', '5,5');
  }
}

/* =========================================================================
   8. 消しゴムツール（SVGマスク非破壊レンダリング）
   ========================================================================= */
function renderEraserMask() {
  gEraserStrokes.selectAll('*').remove();
  document.getElementById('eraser-count-badge').textContent = `${state.eraser.strokes.length} 箇所`;

  const lineGen = d3.line().curve(d3.curveCatmullRom.alpha(0.5));

  state.eraser.strokes.forEach(stroke => {
    if (stroke.points.length === 1) {
      const [cx, cy] = stroke.points[0];
      gEraserStrokes.append('circle')
        .attr('cx', cx).attr('cy', cy)
        .attr('r', stroke.size / 2)
        .attr('fill', '#000000');
    } else if (stroke.points.length >= 2) {
      gEraserStrokes.append('path')
        .attr('d', lineGen(stroke.points))
        .attr('fill', 'none')
        .attr('stroke', '#000000')
        .attr('stroke-width', stroke.size)
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round');
    }
  });
}

function startEraserStroke(startEvent) {
  const svgNode = svg.node();
  const pt = svgNode.createSVGPoint();
  const getSvgCoords = (ev) => {
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const loc = pt.matrixTransform(svgNode.getScreenCTM().inverse());
    return [Math.round(loc.x), Math.round(loc.y)];
  };

  const firstPt = getSvgCoords(startEvent);
  const currentStroke = {
    size: state.eraser.size,
    points: [firstPt]
  };
  state.eraser.strokes.push(currentStroke);
  renderEraserMask();

  function onMove(ev) {
    const nextPt = getSvgCoords(ev);
    eraserCursor.attr('cx', nextPt[0]).attr('cy', nextPt[1]);
    const prevPt = currentStroke.points[currentStroke.points.length - 1];
    if (Math.hypot(nextPt[0] - prevPt[0], nextPt[1] - prevPt[1]) >= 3) {
      currentStroke.points.push(nextPt);
      renderEraserMask();
    }
  }

  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    scheduleAutoSave();
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/* =========================================================================
   9. テレビ番組風ラベル描画エンジン (7種プリセット)
   ========================================================================= */
function renderLabelsLayer() {
  gLabels.selectAll('*').remove();

  state.labels.forEach(item => {
    const isSelected = item.id === state.selectedLabelId && !state.playback.recording;
    const group = gLabels.append('g')
      .attr('class', `draggable-label ${isSelected ? 'selected' : ''}`)
      .attr('transform', `translate(${item.x}, ${item.y}) rotate(${item.rot || 0})`)
      .on('pointerdown', (event) => {
        if (state.tool === 'eraser' || state.playback.recording) return;
        event.stopPropagation();
        selectLabel(item.id);
        startDragLabel(event, item);
      });

    const fontSize = Number(item.size) || 18;
    const textStr = String(item.text || 'ラベル');
    const subStr = String(item.sub || '');
    const padX = Math.max(12, fontSize * 0.65);
    const estWidth = Math.max(64, textStr.length * (fontSize * 0.96) + padX * 2);
    const estHeight = fontSize * 1.9;

    if (isSelected) {
      group.append('rect')
        .attr('class', 'selection-ring')
        .attr('x', -estWidth / 2 - 14)
        .attr('y', -estHeight / 2 - 10)
        .attr('width', estWidth + 28)
        .attr('height', estHeight + 20)
        .attr('rx', 8);
    }

    switch (item.preset) {
      case 'outline': {
        group.append('text')
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize).attr('font-weight', '900')
          .attr('stroke', '#ffffff').attr('stroke-width', 6).attr('stroke-linejoin', 'round')
          .text(textStr);
        group.append('text')
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize).attr('font-weight', '900')
          .attr('fill', item.color)
          .text(textStr);
        break;
      }
      case 'callout': {
        const w = estWidth, h = estHeight;
        group.append('path')
          .attr('d', `M ${-w/2},${-h/2} h ${w} a 6,6 0 0 1 6,6 v ${h-12} a 6,6 0 0 1 -6,6 h ${-w/2 + 8} l -8,10 l -8,-10 h ${-w/2 + 8} a 6,6 0 0 1 -6,-6 v ${-(h-12)} a 6,6 0 0 1 6,-6 z`)
          .attr('fill', '#ffffff').attr('stroke', item.color).attr('stroke-width', 2.8);
        group.append('text')
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize * 0.88).attr('font-weight', '800').attr('fill', item.color)
          .text(textStr);
        break;
      }
      case 'numbered': {
        const badgeR = fontSize * 0.72;
        const totalW = estWidth + badgeR * 1.6;
        group.append('rect')
          .attr('x', -totalW / 2).attr('y', -estHeight / 2)
          .attr('width', totalW).attr('height', estHeight).attr('rx', estHeight / 2)
          .attr('fill', '#ffffff').attr('stroke', item.color).attr('stroke-width', 2.5);
        group.append('circle')
          .attr('cx', -totalW / 2 + badgeR + 4).attr('cy', 0).attr('r', badgeR)
          .attr('fill', item.color);
        group.append('text')
          .attr('x', -totalW / 2 + badgeR + 4).attr('y', 0)
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize * 0.75).attr('font-weight', '900').attr('fill', '#ffffff')
          .text(subStr || '①');
        group.append('text')
          .attr('x', badgeR * 0.55).attr('y', 0)
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize * 0.86).attr('font-weight', '800').attr('fill', '#1f2937')
          .text(textStr);
        break;
      }
      case 'station': {
        const w = estWidth + 12, h = estHeight + 4;
        group.append('rect')
          .attr('x', -w / 2).attr('y', -h / 2).attr('width', w).attr('height', h).attr('rx', 4)
          .attr('fill', '#ffffff').attr('stroke', '#1e3a8a').attr('stroke-width', 3);
        group.append('rect')
          .attr('x', -w / 2).attr('y', h / 2 - 6).attr('width', w).attr('height', 6)
          .attr('fill', item.color);
        group.append('text')
          .attr('y', -2).attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize * 0.86).attr('font-weight', '800').attr('fill', '#111827')
          .text(textStr);
        break;
      }
      case 'ribbon': {
        const w = estWidth + 18, h = estHeight + 2;
        group.append('rect')
          .attr('x', -w / 2).attr('y', -h / 2).attr('width', w).attr('height', h).attr('rx', 4)
          .attr('fill', '#ffffff').attr('stroke', '#cbd5e1').attr('stroke-width', 1.8);
        group.append('rect')
          .attr('x', -w / 2).attr('y', -h / 2).attr('width', 10).attr('height', h).attr('rx', 2)
          .attr('fill', item.color);
        group.append('text')
          .attr('x', 4).attr('y', 0).attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize * 0.88).attr('font-weight', '800').attr('fill', '#1f2937')
          .text(textStr);
        break;
      }
      case 'wood': {
        const w = estWidth + 14, h = estHeight + 4;
        group.append('rect')
          .attr('x', -w / 2).attr('y', -h / 2).attr('width', w).attr('height', h).attr('rx', 3)
          .attr('fill', '#f3e5ab').attr('stroke', '#78350f').attr('stroke-width', 3);
        group.append('rect')
          .attr('x', -w / 2 + 3).attr('y', -h / 2 + 3).attr('width', w - 6).attr('height', h - 6).attr('rx', 2)
          .attr('fill', 'none').attr('stroke', '#b45309').attr('stroke-width', 1);
        group.append('text')
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize * 0.88).attr('font-weight', '800').attr('fill', '#451a03')
          .text(textStr);
        break;
      }
      case 'badge': {
        const w = estWidth + 16, h = estHeight;
        group.append('rect')
          .attr('x', -w / 2).attr('y', -h / 2).attr('width', w).attr('height', h).attr('rx', h / 2)
          .attr('fill', item.color).attr('stroke', '#ffffff').attr('stroke-width', 2.8);
        group.append('text')
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
          .attr('font-size', fontSize * 0.86).attr('font-weight', '800').attr('fill', '#ffffff')
          .text(textStr);
        break;
      }
    }
  });
}

function startDragLabel(startEvent, labelItem) {
  const svgNode = svg.node();
  const pt = svgNode.createSVGPoint();
  const getSvgCoords = (ev) => {
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    return pt.matrixTransform(svgNode.getScreenCTM().inverse());
  };
  const startPos = getSvgCoords(startEvent);
  const origX = labelItem.x;
  const origY = labelItem.y;

  function onMove(ev) {
    const cur = getSvgCoords(ev);
    labelItem.x = Math.round(Math.max(20, Math.min(SVG_W - 20, origX + (cur.x - startPos.x))));
    labelItem.y = Math.round(Math.max(20, Math.min(SVG_H - 20, origY + (cur.y - startPos.y))));
    renderLabelsLayer();
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    scheduleAutoSave();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/* =========================================================================
   10. 散策ルート＆7種の現在地アニメーション描画エンジン
   ========================================================================= */
function renderRouteAndMarker() {
  gRoute.selectAll('*').remove();
  document.getElementById('route-count-badge').textContent = `${state.routePoints.length} 頂点`;

  if (state.routePoints.length < 2) {
    gMarker.selectAll('*').remove();
    if (state.routePoints.length === 1) {
      const [x, y] = state.routePoints[0];
      drawCurrentLocationMarker(x, y, state.playback.animTimeSec);
    }
    return;
  }

  const curveFactory = state.routeConfig.curve === 'catmull' ? d3.curveCatmullRom.alpha(0.5) : d3.curveLinear;
  const lineGen = d3.line().curve(curveFactory);
  const pathData = lineGen(state.routePoints);

  const casingPath = gRoute.append('path')
    .attr('d', pathData)
    .attr('fill', 'none')
    .attr('stroke', '#ffffff')
    .attr('stroke-width', Number(state.routeConfig.width) + 4)
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round');

  const mainPath = gRoute.append('path')
    .attr('d', pathData)
    .attr('fill', 'none')
    .attr('stroke', state.routeConfig.color)
    .attr('stroke-width', Number(state.routeConfig.width))
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round');

  const pathNode = mainPath.node();
  const totalLen = pathNode.getTotalLength();

  if (state.routeConfig.style === 'dashed') {
    mainPath.attr('stroke-dasharray', '10, 8');
  } else if (state.routeConfig.style === 'dots') {
    mainPath.attr('stroke-dasharray', '2, 11');
  }

  const revealPath = gRoute.append('path')
    .attr('d', pathData)
    .attr('fill', 'none')
    .attr('stroke', state.routeConfig.color)
    .attr('stroke-width', Number(state.routeConfig.width))
    .attr('stroke-linecap', 'round')
    .attr('stroke-dasharray', `${totalLen} ${totalLen}`)
    .attr('stroke-dashoffset', totalLen * (1 - state.playback.progress));

  if (state.routeConfig.style !== 'solid') {
    const mask = gRoute.append('mask').attr('id', 'route-reveal-mask');
    mask.append('path')
      .attr('d', pathData)
      .attr('fill', 'none')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', Number(state.routeConfig.width) + 10)
      .attr('stroke-linecap', 'round')
      .attr('stroke-dasharray', `${totalLen} ${totalLen}`)
      .attr('stroke-dashoffset', totalLen * (1 - state.playback.progress));
    casingPath.attr('mask', 'url(#route-reveal-mask)');
    mainPath.attr('mask', 'url(#route-reveal-mask)');
    revealPath.remove();
  } else {
    mainPath.remove();
    casingPath.attr('stroke-dasharray', `${totalLen} ${totalLen}`)
      .attr('stroke-dashoffset', totalLen * (1 - state.playback.progress));
  }

  const [sx, sy] = state.routePoints[0];
  gRoute.append('circle')
    .attr('cx', sx).attr('cy', sy).attr('r', 6)
    .attr('fill', '#ffffff').attr('stroke', state.routeConfig.color).attr('stroke-width', 3);

  if (!state.playback.recording && (state.tool === 'draw-route' || state.tool === 'select')) {
    state.routePoints.forEach((pt, idx) => {
      gRoute.append('circle')
        .attr('class', 'route-vertex')
        .attr('cx', pt[0]).attr('cy', pt[1]).attr('r', 5.5)
        .attr('fill', idx === state.routePoints.length - 1 ? state.routeConfig.color : '#ffffff')
        .attr('stroke', '#1f2937').attr('stroke-width', 2)
        .on('pointerdown', (ev) => {
          ev.stopPropagation();
          startDragRouteVertex(ev, idx);
        });
    });
  }

  const currentDist = totalLen * state.playback.progress;
  const pt = pathNode.getPointAtLength(currentDist);
  drawCurrentLocationMarker(pt.x, pt.y, state.playback.animTimeSec);
}

function drawCurrentLocationMarker(x, y, t = 0) {
  gMarker.selectAll('*').remove();
  const wrap = gMarker.append('g').attr('transform', `translate(${x}, ${y})`);
  const type = state.playback.animType;
  const isRec = state.playback.recording;

  if (type === 'pulse') {
    const p1 = (t % 1.8) / 1.8;
    const p2 = ((t + 0.6) % 1.8) / 1.8;
    const r1 = 14 * (0.4 + 2.4 * p1);
    const op1 = 0.9 * (1 - p1);
    const r2 = 14 * (0.4 + 2.4 * p2);
    const op2 = 0.7 * (1 - p2);

    wrap.append('circle')
      .attr('class', isRec ? '' : 'marker-pulse-1')
      .attr('r', isRec ? r1 : 14)
      .attr('fill', isRec ? `rgba(239, 68, 68, ${op1.toFixed(3)})` : 'rgba(239, 68, 68, 0.45)');
    wrap.append('circle')
      .attr('class', isRec ? '' : 'marker-pulse-2')
      .attr('r', isRec ? r2 : 14)
      .attr('fill', isRec ? `rgba(239, 68, 68, ${op2.toFixed(3)})` : 'rgba(239, 68, 68, 0.3)');
    wrap.append('circle').attr('r', 8).attr('fill', '#ef4444').attr('stroke', '#ffffff').attr('stroke-width', 3);

  } else if (type === 'bounce') {
    const phase = Math.abs(Math.sin(t * Math.PI * 1.35));
    const dy = isRec ? -16 * phase : 0;
    const sScale = isRec ? 1 - 0.45 * phase : 1;

    wrap.append('ellipse')
      .attr('class', isRec ? '' : 'marker-bounce-shadow')
      .attr('cx', 0).attr('cy', 3)
      .attr('rx', 8 * sScale).attr('ry', 3.5 * sScale)
      .attr('fill', 'rgba(0,0,0,0.38)');
    const pin = wrap.append('g')
      .attr('class', isRec ? '' : 'marker-bounce-body')
      .attr('transform', isRec ? `translate(0, ${dy.toFixed(2)})` : null);
    pin.append('path')
      .attr('d', 'M 0,0 C -8,-10 -13,-17 -13,-24 A 13,13 0 1 1 13,-24 C 13,-17 8,-10 0,0 Z')
      .attr('fill', '#ef4444').attr('stroke', '#ffffff').attr('stroke-width', 2.5);
    pin.append('circle').attr('cx', 0).attr('cy', -24).attr('r', 5).attr('fill', '#ffffff');

  } else if (type === 'walk') {
    const deg = isRec ? Math.sin(t * Math.PI * 3.6) * 10 : 0;
    const dy = isRec ? -Math.abs(Math.cos(t * Math.PI * 3.6)) * 5 : 0;
    const walker = wrap.append('g')
      .attr('class', isRec ? '' : 'marker-walk-body')
      .attr('transform', isRec ? `translate(0, ${dy.toFixed(2)}) rotate(${deg.toFixed(2)})` : null);
    walker.append('circle').attr('cx', 0).attr('cy', -12).attr('r', 14).attr('fill', '#ffffff').attr('stroke', '#2563eb').attr('stroke-width', 3);
    walker.append('text').attr('x', 0).attr('y', -11).attr('text-anchor', 'middle').attr('dominant-baseline', 'central').attr('font-size', '16px').text('🚶');

  } else if (type === 'star') {
    const deg = isRec ? (t * 140) % 360 : 0;
    const sc = isRec ? 1 + 0.14 * Math.sin(t * Math.PI * 2) : 1;
    const star = wrap.append('g')
      .attr('class', isRec ? '' : 'marker-star-body')
      .attr('transform', isRec ? `rotate(${deg.toFixed(1)}) scale(${sc.toFixed(2)})` : null);
    star.append('polygon')
      .attr('points', '0,-16 4.5,-5 16,-4 7,4 9.5,15 0,9 -9.5,15 -7,4 -16,-4 -4.5,-5')
      .attr('fill', '#facc15').attr('stroke', '#b45309').attr('stroke-width', 2.2);

  } else if (type === 'heart') {
    const sc = isRec ? 1 + 0.25 * Math.pow(Math.sin(t * Math.PI * 2.2), 4) : 1;
    const heart = wrap.append('g')
      .attr('class', isRec ? '' : 'marker-heart-body')
      .attr('transform', isRec ? `scale(${sc.toFixed(2)})` : null);
    heart.append('circle').attr('r', 14).attr('fill', '#ffffff').attr('stroke', '#ec4899').attr('stroke-width', 2.5);
    heart.append('path')
      .attr('d', 'M 0,7 C -8,1 -10,-5 -5,-8 C -2,-10 0,-6 0,-6 C 0,-6 2,-10 5,-8 C 10,-5 8,1 0,7 Z')
      .attr('fill', '#ec4899');

  } else if (type === 'compass') {
    const deg = isRec ? Math.sin(t * Math.PI * 1.5) * 30 : 0;
    wrap.append('circle').attr('r', 14).attr('fill', '#ffffff').attr('stroke', '#1e293b').attr('stroke-width', 2.8);
    const needle = wrap.append('g')
      .attr('class', isRec ? '' : 'marker-compass-needle')
      .attr('transform', isRec ? `rotate(${deg.toFixed(1)})` : null);
    needle.append('polygon').attr('points', '0,-11 4,0 -4,0').attr('fill', '#ef4444');
    needle.append('polygon').attr('points', '0,11 4,0 -4,0').attr('fill', '#475569');
    wrap.append('circle').attr('r', 2.2).attr('fill', '#ffffff');

  } else if (type === 'flag') {
    const deg = isRec ? Math.sin(t * Math.PI * 2.5) * 8 : 0;
    wrap.append('ellipse').attr('cx', 0).attr('cy', 2).attr('rx', 7).attr('ry', 3).attr('fill', 'rgba(0,0,0,0.28)');
    const flag = wrap.append('g')
      .attr('class', isRec ? '' : 'marker-flag-body')
      .attr('transform', isRec ? `rotate(${deg.toFixed(1)})` : null);
    flag.append('line').attr('x1', 0).attr('y1', 2).attr('x2', 0).attr('y2', -26).attr('stroke', '#1f2937').attr('stroke-width', 3).attr('stroke-linecap', 'round');
    flag.append('path').attr('d', 'M 0,-26 L 20,-20 L 0,-13 Z').attr('fill', '#ef4444').attr('stroke', '#ffffff').attr('stroke-width', 1.5);
  }
}

function startDragRouteVertex(startEvent, idx) {
  const svgNode = svg.node();
  const pt = svgNode.createSVGPoint();
  const getSvgCoords = (ev) => {
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    return pt.matrixTransform(svgNode.getScreenCTM().inverse());
  };
  function onMove(ev) {
    const cur = getSvgCoords(ev);
    state.routePoints[idx] = [
      Math.round(Math.max(10, Math.min(SVG_W - 10, cur.x))),
      Math.round(Math.max(10, Math.min(SVG_H - 10, cur.y)))
    ];
    renderRouteAndMarker();
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    scheduleAutoSave();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/* =========================================================================
   11. ライブ再生制御 ＆ アニメーション動画出力 (中断制御対応)
   ========================================================================= */
const playBtn = document.getElementById('btn-play-toggle');
const progressSlider = document.getElementById('route-progress');

function stopPlayback() {
  state.playback.playing = false;
  if (state.playback.rafId) {
    cancelAnimationFrame(state.playback.rafId);
    state.playback.rafId = null;
  }
  playBtn.textContent = '▶ 再生';
}

function togglePlayback() {
  if (state.playback.recording) return;
  if (state.playback.playing) {
    stopPlayback();
  } else {
    if (state.playback.progress >= 0.99) state.playback.progress = 0;
    state.playback.playing = true;
    state.playback.lastTimestamp = 0;
    playBtn.textContent = '⏸ 一時停止';
    state.playback.rafId = requestAnimationFrame(stepPlayback);
  }
}

function stepPlayback(timestamp) {
  if (!state.playback.playing) return;
  if (!state.playback.lastTimestamp) state.playback.lastTimestamp = timestamp;
  const dt = (timestamp - state.playback.lastTimestamp) / 1000;
  state.playback.lastTimestamp = timestamp;
  state.playback.animTimeSec += dt;

  state.playback.progress += (dt / 5.0) * state.playback.speed;
  if (state.playback.progress >= 1) {
    state.playback.progress = 1;
    progressSlider.value = 1000;
    renderRouteAndMarker();
    stopPlayback();
    return;
  }
  progressSlider.value = Math.round(state.playback.progress * 1000);
  renderRouteAndMarker();
  state.playback.rafId = requestAnimationFrame(stepPlayback);
}

playBtn.addEventListener('click', togglePlayback);

progressSlider.addEventListener('input', (e) => {
  if (state.playback.recording) return;
  stopPlayback();
  state.playback.progress = Number(e.target.value) / 1000;
  renderRouteAndMarker();
});

document.getElementById('anim-type-select').addEventListener('change', (e) => {
  state.playback.animType = e.target.value;
  renderRouteAndMarker();
  scheduleAutoSave();
});

document.getElementById('anim-speed-select').addEventListener('change', (e) => {
  state.playback.speed = Number(e.target.value) || 1;
  scheduleAutoSave();
});

function renderCurrentSvgToCanvas(ctx, width, height) {
  return new Promise((resolve, reject) => {
    const clone = svg.node().cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', width);
    clone.setAttribute('height', height);
    const overlay = clone.querySelector('#layer-ui-overlay');
    if (overlay) overlay.remove();

    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

async function exportAnimationVideo() {
  if (state.playback.recording) return;
  stopPlayback();

  const exportBtn = document.getElementById('btn-export-video');
  const banner = document.getElementById('recording-banner');
  const bannerText = document.getElementById('recording-status-text');

  state.playback.recording = true;
  state.playback.cancelRecordingRequested = false;
  exportBtn.disabled = true;
  banner.hidden = false;
  eraserCursor.style('display', 'none');
  renderLabelsLayer();

  const REC_W = 1280;
  const REC_H = 800;
  const FPS = 30;
  const baseDurationSec = 5.0 / state.playback.speed;
  const tailHoldSec = 1.0;
  const totalSec = baseDurationSec + tailHoldSec;
  const totalFrames = Math.ceil(totalSec * FPS);

  const canvas = document.createElement('canvas');
  canvas.width = REC_W;
  canvas.height = REC_H;
  const ctx = canvas.getContext('2d');

  const mimeCandidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  const selectedMime = mimeCandidates.find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || '';

  const stream = canvas.captureStream(FPS);
  const recorder = new MediaRecorder(stream, selectedMime ? { mimeType: selectedMime, videoBitsPerSecond: 6000000 } : undefined);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const recordingDone = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  recorder.start();

  try {
    for (let f = 0; f <= totalFrames; f++) {
      if (state.playback.cancelRecordingRequested) break;

      const tSec = f / FPS;
      state.playback.animTimeSec = tSec;
      state.playback.progress = Math.min(1.0, tSec / baseDurationSec);
      progressSlider.value = Math.round(state.playback.progress * 1000);

      renderRouteAndMarker();
      await renderCurrentSvgToCanvas(ctx, REC_W, REC_H);

      const pct = Math.round((f / totalFrames) * 100);
      bannerText.textContent = `動画レンダリング中... (${pct}%)`;

      await new Promise(r => setTimeout(r, 1000 / FPS));
    }
  } catch (err) {
    console.error('Video export error:', err);
    showToast('動画出力中にエラーが発生しました', true);
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    await recordingDone;

    if (!state.playback.cancelRecordingRequested && chunks.length > 0) {
      const blob = new Blob(chunks, { type: selectedMime || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wipemap_animation_${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast('🎬 アニメーション動画 (WebM) を書き出しました');
      setHudStatus('アニメーション動画 (WebM) の書き出しが完了しました');
    } else if (state.playback.cancelRecordingRequested) {
      showToast('動画レンダリングを中断しました');
      setHudStatus('動画出力を中断しました');
    }

    state.playback.recording = false;
    state.playback.cancelRecordingRequested = false;
    exportBtn.disabled = false;
    banner.hidden = true;
    renderLabelsLayer();
    renderRouteAndMarker();
  }
}

document.getElementById('btn-export-video').addEventListener('click', exportAnimationVideo);
document.getElementById('btn-cancel-video').addEventListener('click', () => {
  state.playback.cancelRecordingRequested = true;
});

/* =========================================================================
   12. プロジェクト保存・読込・D&D・初期化イベントハンドラ
   ========================================================================= */
// JSONプロジェクト保存
document.getElementById('btn-save-project').addEventListener('click', () => {
  try {
    const projectObj = serializeCurrentProject();
    const jsonStr = JSON.stringify(projectObj, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `wipemap_project_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast('📥 プロジェクト (.json) を保存しました');
    setHudStatus('プロジェクトファイルを保存しました');
  } catch (err) {
    console.error(err);
    showToast('プロジェクト保存に失敗しました', true);
  }
});

// JSONファイル読込関数
async function loadProjectFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const cleanData = sanitizeProjectPayload(parsed);
    await applyProjectData(cleanData, true);
    showToast(`📂 プロジェクト「${file.name}」を復元しました`);
    setHudStatus(`プロジェクト「${file.name}」を読み込みました`);
  } catch (err) {
    console.error(err);
    showToast(err.message || 'JSONファイルの読み込みに失敗しました', true);
  }
}

const fileInput = document.getElementById('project-file-input');
document.getElementById('btn-load-project').addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) loadProjectFromFile(file);
});

// ドラッグ＆ドロップでJSONプロジェクト読込
const dropZone = document.getElementById('drop-zone');
const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;

dropZone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
});

dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) loadProjectFromFile(file);
});

// プロジェクト初期化
document.getElementById('btn-reset-project').addEventListener('click', async () => {
  localStorage.removeItem(STORAGE_AUTOSAVE_KEY);
  const fresh = sanitizeProjectPayload(createDefaultProjectState());
  await applyProjectData(fresh, true);
  showToast('🔄 初期サンプル状態にリセットしました');
});

/* =========================================================================
   13. UI・ツール切り替え・インスペクター・ショートカットイベント
   ========================================================================= */
function selectLabel(id) {
  state.selectedLabelId = id;
  const item = state.labels.find(l => l.id === id);
  if (item) {
    document.getElementById('lbl-text').value = item.text;
    document.getElementById('lbl-sub').value = item.sub || '';
    document.getElementById('lbl-color').value = item.color;
    document.getElementById('lbl-size').value = item.size;
    document.getElementById('lbl-size-val').textContent = `${item.size}px`;
    document.getElementById('lbl-rot').value = item.rot || 0;
    document.getElementById('lbl-rot-val').textContent = `${item.rot || 0}°`;
    document.querySelectorAll('#preset-grid .preset-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === item.preset);
    });
  }
  renderLabelsLayer();
}

function activateTool(toolName) {
  state.tool = toolName;
  document.querySelectorAll('.tool-rail .rail-btn[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === toolName);
  });

  const eraserSection = document.getElementById('eraser-inspector-section');
  eraserSection.classList.toggle('highlight-tool', state.tool === 'eraser');
  eraserCursor.style('display', state.tool === 'eraser' ? 'block' : 'none');

  if (state.tool === 'select') setHudStatus('選択モード：ラベルやルート頂点をドラッグして位置調整できます');
  if (state.tool === 'add-label') setHudStatus('ラベル追加モード：地図上の配置したい場所をクリックしてください');
  if (state.tool === 'draw-route') setHudStatus('ルート描画モード：地図上を順番にクリックして散策ルートを伸ばします');
  if (state.tool === 'eraser') setHudStatus('消しゴムモード：不要な道路や線をドラッグして消去できます（ラベルとルートは保護されます）');

  renderRouteAndMarker();
}

document.querySelectorAll('.tool-rail .rail-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => activateTool(btn.dataset.tool));
});

svg.on('pointermove', (event) => {
  if (state.tool !== 'eraser' || state.playback.recording) return;
  const svgNode = svg.node();
  const pt = svgNode.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const loc = pt.matrixTransform(svgNode.getScreenCTM().inverse());
  eraserCursor
    .attr('cx', Math.round(loc.x))
    .attr('cy', Math.round(loc.y))
    .attr('r', state.eraser.size / 2)
    .style('display', 'block');
});

svg.on('pointerleave', () => {
  eraserCursor.style('display', 'none');
});

svg.on('pointerdown', (event) => {
  if (state.playback.recording) return;

  if (state.tool === 'eraser') {
    startEraserStroke(event);
    return;
  }

  const svgNode = svg.node();
  const pt = svgNode.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const loc = pt.matrixTransform(svgNode.getScreenCTM().inverse());
  const x = Math.round(loc.x);
  const y = Math.round(loc.y);

  if (state.tool === 'add-label') {
    const newId = `lbl-${Date.now()}`;
    const activePreset = document.querySelector('#preset-grid .preset-chip.active')?.dataset.preset || 'outline';
    state.labels.push({
      id: newId,
      x, y,
      text: '新規スポット',
      sub: `${state.labels.length + 1}`,
      preset: activePreset,
      color: document.getElementById('lbl-color').value,
      size: Number(document.getElementById('lbl-size').value) || 18,
      rot: 0
    });
    selectLabel(newId);
    scheduleAutoSave();
  } else if (state.tool === 'draw-route') {
    state.routePoints.push([x, y]);
    state.playback.progress = 1.0;
    progressSlider.value = 1000;
    renderRouteAndMarker();
    scheduleAutoSave();
  }
});

// 消しゴム設定UI
document.getElementById('eraser-size').addEventListener('input', (e) => {
  state.eraser.size = Number(e.target.value);
  document.getElementById('eraser-size-val').textContent = `${state.eraser.size}px`;
  eraserCursor.attr('r', state.eraser.size / 2);
  scheduleAutoSave();
});

document.getElementById('btn-undo-eraser').addEventListener('click', () => {
  state.eraser.strokes.pop();
  renderEraserMask();
  scheduleAutoSave();
});

document.getElementById('btn-clear-eraser').addEventListener('click', () => {
  state.eraser.strokes = [];
  renderEraserMask();
  scheduleAutoSave();
});

// ラベルインスペクター
document.querySelectorAll('#preset-grid .preset-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#preset-grid .preset-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const item = state.labels.find(l => l.id === state.selectedLabelId);
    if (item) {
      item.preset = chip.dataset.preset;
      renderLabelsLayer();
      scheduleAutoSave();
    }
  });
});

['lbl-text', 'lbl-sub', 'lbl-color', 'lbl-size', 'lbl-rot'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const item = state.labels.find(l => l.id === state.selectedLabelId);
    if (!item) return;
    if (id === 'lbl-text') item.text = e.target.value;
    if (id === 'lbl-sub') item.sub = e.target.value;
    if (id === 'lbl-color') item.color = e.target.value;
    if (id === 'lbl-size') {
      item.size = Number(e.target.value);
      document.getElementById('lbl-size-val').textContent = `${item.size}px`;
    }
    if (id === 'lbl-rot') {
      item.rot = Number(e.target.value);
      document.getElementById('lbl-rot-val').textContent = `${item.rot}°`;
    }
    renderLabelsLayer();
    scheduleAutoSave();
  });
});

document.getElementById('btn-new-label').addEventListener('click', () => {
  const newId = `lbl-${Date.now()}`;
  state.labels.push({
    id: newId,
    x: Math.round(SVG_W / 2 + (Math.random() - 0.5) * 120),
    y: Math.round(SVG_H / 2 + (Math.random() - 0.5) * 80),
    text: '注目スポット',
    sub: '★',
    preset: 'callout',
    color: '#2563eb',
    size: 18,
    rot: 0
  });
  selectLabel(newId);
  scheduleAutoSave();
});

function deleteSelectedLabel() {
  if (!state.selectedLabelId) return;
  state.labels = state.labels.filter(l => l.id !== state.selectedLabelId);
  state.selectedLabelId = state.labels[0]?.id || null;
  if (state.selectedLabelId) selectLabel(state.selectedLabelId);
  else renderLabelsLayer();
  scheduleAutoSave();
}

document.getElementById('btn-delete-label').addEventListener('click', deleteSelectedLabel);

// 主要地名の自動配置
document.getElementById('btn-auto-labels').addEventListener('click', () => {
  if (!state.mapGeoData || !state.mapGeoData.categorized.poiLabels.length) {
    showToast('現在の地図範囲から抽出できる地名データがありませんでした', true);
    return;
  }
  const { poiLabels } = state.mapGeoData.categorized;
  const { projection } = state.mapGeoData;
  const usedNames = new Set(state.labels.map(l => l.text));
  let added = 0;

  for (const poi of poiLabels) {
    if (usedNames.has(poi.name)) continue;
    const [px, py] = projection(poi.coords);
    if (px < 50 || px > SVG_W - 50 || py < 40 || py > SVG_H - 40) continue;
    const tooClose = state.labels.some(l => Math.hypot(l.x - px, l.y - py) < 85);
    if (tooClose) continue;

    usedNames.add(poi.name);
    state.labels.push({
      id: `lbl-auto-${Date.now()}-${added}`,
      x: Math.round(px),
      y: Math.round(py),
      text: poi.name,
      sub: poi.isStation ? '駅' : '地名',
      preset: poi.isStation ? 'station' : 'outline',
      color: poi.isStation ? '#1d4ed8' : '#374151',
      size: poi.isStation ? 16 : 15,
      rot: 0
    });
    added++;
    if (added >= 6) break;
  }
  renderLabelsLayer();
  scheduleAutoSave();
  showToast(`✨ ${added}件の主要地名・駅ラベルを自動配置しました`);
});

// レイヤーON/OFF・テーマ変更
document.querySelectorAll('#layer-toggles .layer-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const key = pill.dataset.layer;
    state.layers[key] = !state.layers[key];
    pill.classList.toggle('active', state.layers[key]);
    renderMapVectorLayer();
    scheduleAutoSave();
  });
});

document.getElementById('theme-select').addEventListener('change', (e) => {
  state.theme = e.target.value;
  renderMapVectorLayer();
  scheduleAutoSave();
});

// ルート設定
['route-style', 'route-curve', 'route-color', 'route-width'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    if (id === 'route-style') state.routeConfig.style = e.target.value;
    if (id === 'route-curve') state.routeConfig.curve = e.target.value;
    if (id === 'route-color') state.routeConfig.color = e.target.value;
    if (id === 'route-width') {
      state.routeConfig.width = Number(e.target.value);
      document.getElementById('route-width-val').textContent = `${e.target.value}px`;
    }
    renderRouteAndMarker();
    scheduleAutoSave();
  });
});

document.getElementById('btn-undo-route').addEventListener('click', () => {
  state.routePoints.pop();
  renderRouteAndMarker();
  scheduleAutoSave();
});

document.getElementById('btn-clear-route').addEventListener('click', () => {
  state.routePoints = [];
  renderRouteAndMarker();
  scheduleAutoSave();
});

// グローバルキーボードショートカット
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const isInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

  if (e.key === 'Escape') {
    if (state.playback.recording) {
      state.playback.cancelRecordingRequested = true;
    } else if (mapModal.classList.contains('open')) {
      closeMapModal();
    } else {
      activateTool('select');
    }
    return;
  }

  if (isInput) return;

  if (e.code === 'Space') {
    e.preventDefault();
    togglePlayback();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (state.tool === 'eraser' && state.eraser.strokes.length > 0) {
      state.eraser.strokes.pop();
      renderEraserMask();
      scheduleAutoSave();
      showToast('消しゴムの消去を1つ戻しました');
    } else if (state.routePoints.length > 0) {
      state.routePoints.pop();
      renderRouteAndMarker();
      scheduleAutoSave();
      showToast('ルート頂点を1点戻しました');
    }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelectedLabel();
  } else if (e.key.toLowerCase() === 'v') {
    activateTool('select');
  } else if (e.key.toLowerCase() === 'l') {
    activateTool('add-label');
  } else if (e.key.toLowerCase() === 'r') {
    activateTool('draw-route');
  } else if (e.key.toLowerCase() === 'e') {
    activateTool('eraser');
  }
});

/* =========================================================================
   14. 地図範囲選択モーダル & SVG保存
   ========================================================================= */
const mapModal = document.getElementById('map-modal');
let leafletMap = null;

function openMapModal() {
  mapModal.classList.add('open');
  if (!leafletMap) {
    leafletMap = L.map('leaflet-map');
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '出典：国土地理院'
    }).addTo(leafletMap);

    leafletMap.on('moveend zoomend', () => {
      const z = leafletMap.getZoom();
      const cfg = getOptimalTileConfig(z);
      document.getElementById('modal-zoom-badge').textContent = cfg.label;
    });
  }

  const currentBounds = L.latLngBounds(
    [state.mapRegion.south, state.mapRegion.west],
    [state.mapRegion.north, state.mapRegion.east]
  );
  setTimeout(() => {
    leafletMap.invalidateSize();
    leafletMap.fitBounds(currentBounds);
  }, 60);
}

function closeMapModal() {
  mapModal.classList.remove('open');
}

document.getElementById('btn-open-map').addEventListener('click', openMapModal);
document.getElementById('btn-center-map').addEventListener('click', openMapModal);
document.getElementById('btn-close-modal').addEventListener('click', closeMapModal);

document.getElementById('btn-preset-island').addEventListener('click', () => {
  if (leafletMap) leafletMap.setView([34.48, 134.88], 10);
});
document.getElementById('btn-preset-town').addEventListener('click', () => {
  if (leafletMap) leafletMap.setView([34.815, 135.345], 15);
});

document.getElementById('btn-execute-extract').addEventListener('click', async () => {
  if (!leafletMap) return;
  const bounds = leafletMap.getBounds();
  const zoom = leafletMap.getZoom();
  closeMapModal();
  await extractVectorMapFromBounds(bounds, zoom);
});

// SVG保存
document.getElementById('btn-export-svg').addEventListener('click', () => {
  const prevSelected = state.selectedLabelId;
  state.selectedLabelId = null;
  renderLabelsLayer();

  const cloneSvg = svg.node().cloneNode(true);
  cloneSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const overlay = cloneSvg.querySelector('#layer-ui-overlay');
  if (overlay) overlay.remove();

  const source = new XMLSerializer().serializeToString(cloneSvg);
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `wipemap_${Date.now()}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  state.selectedLabelId = prevSelected;
  renderLabelsLayer();
  showToast('💾 SVGファイルを書き出しました');
});

/* =========================================================================
   15. 初期起動処理（自動バックアップの復元または初期サンプル描画）
   ========================================================================= */
(async function initApp() {
  let initialProject = null;
  try {
    const savedRaw = localStorage.getItem(STORAGE_AUTOSAVE_KEY);
    if (savedRaw) {
      initialProject = sanitizeProjectPayload(JSON.parse(savedRaw));
    }
  } catch {
    initialProject = null;
  }

  if (initialProject) {
    await applyProjectData(initialProject, true);
    showToast('前回の作業状態を自動復元しました');
  } else {
    const defaultClean = sanitizeProjectPayload(createDefaultProjectState());
    await applyProjectData(defaultClean, true);
  }
})();