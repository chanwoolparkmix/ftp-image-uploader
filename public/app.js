// 로그인 상태 관리
let authCredentials = null;

const loginContainer = document.getElementById('loginContainer');
const mainContainer = document.getElementById('mainContainer');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const loading = document.getElementById('loading');
const results = document.getElementById('results');
const resultsList = document.getElementById('resultsList');
const errorDiv = document.getElementById('error');
const optimizeCheck = document.getElementById('optimizeCheck');
const webpCheck = document.getElementById('webpCheck');
const adCheck = document.getElementById('adCheck');
const limitCheck = document.getElementById('limitCheck');
const limitBadge = document.getElementById('limitBadge');

const API_ENDPOINT = '/api/upload';

const MAX_DIMENSION = 1200;
const QUALITY = 0.85;
const MAX_CANVAS_SIZE = 4096;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const settingsSummary = document.getElementById('settingsSummary');

// 용량 제한 체크박스 토글
limitCheck.addEventListener('change', () => {
    limitBadge.textContent = limitCheck.checked ? '10MB' : '해제됨';
});

// ── 설정 모달 ──
function openSettings() {
    if (typeof settingsModal.showModal === 'function') {
        settingsModal.showModal();
    } else {
        settingsModal.setAttribute('open', ''); // <dialog> 미지원 브라우저 대비
    }
}

function closeSettings() {
    if (typeof settingsModal.close === 'function') settingsModal.close();
    else settingsModal.removeAttribute('open');
}

settingsBtn.addEventListener('click', openSettings);
settingsSummary.addEventListener('click', openSettings);

// 바깥(배경) 클릭 시 닫기
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
});

// ── srcset 사이즈 설정 ──
const srcsetCheck = document.getElementById('srcsetCheck');
const srcsetEditor = document.getElementById('srcsetEditor');
const srcsetRows = document.getElementById('srcsetRows');
const srcsetPreview = document.getElementById('srcsetPreview');
const srcsetError = document.getElementById('srcsetError');
const addVariantBtn = document.getElementById('addVariantBtn');
const resetVariantBtn = document.getElementById('resetVariantBtn');

const DEFAULT_VARIANTS = [
    { name: 'large', px: 1200 },
    { name: 'medium', px: 860 },
    { name: 'small', px: 480 }
];
// 이전 버전의 기본값 (그대로 쓰던 경우 새 기본값으로 교체)
const OLD_DEFAULT_VARIANTS_JSON = JSON.stringify([
    { name: 'large', px: 1200 }, { name: 'medium', px: 800 }, { name: 'small', px: 400 }
]);
const MAX_VARIANTS = 10;
const MAX_VARIANT_PX = MAX_CANVAS_SIZE * 2;
const LEGACY_VARIANT_KEY = 'srcsetVariants'; // 예전 버전(이 기기에만 저장)

// ── 설정 동기화 (모든 기기에서 동일한 설정) ──
// 서버(FTP의 JSON 파일)가 기준이고, localStorage는 오프라인/빠른 로딩용 캐시.
const SETTINGS_API = '/api/settings';
const SETTINGS_CACHE_KEY = 'uploaderSettings';
const SYNC_DELAY = 800;          // 변경 후 이 시간(ms) 동안 추가 변경이 없으면 저장
const PULL_MIN_INTERVAL = 5000;  // 포커스 복귀 시 서버 확인 최소 간격

const syncStatus = document.getElementById('syncStatus');
let applyingSettings = false;    // 코드가 설정을 적용하는 중에는 저장 예약을 막음
let syncTimer = null;
let pushing = false;
let pushQueued = false;
let lastPullAt = 0;

// 동기화 대상: srcset 사용 여부 + 사이즈 목록만.
// WebP·최적화·광고·용량 제한은 저장하지 않고 접속할 때마다 기본값으로 시작한다.
function defaultSettings() {
    return {
        srcset: true,
        variants: DEFAULT_VARIANTS.map((v) => ({ ...v }))
    };
}

// 누락/손상된 값은 기본값으로 채움
function normalizeSettings(raw) {
    const d = defaultSettings();
    if (!raw || typeof raw !== 'object') return d;
    const out = { srcset: typeof raw.srcset === 'boolean' ? raw.srcset : d.srcset };
    const variants = Array.isArray(raw.variants)
        ? raw.variants
            .filter((v) => v && typeof v.name === 'string' && Number.isFinite(Number(v.px)))
            .slice(0, MAX_VARIANTS)
            .map((v) => ({ name: v.name, px: Number(v.px) }))
        : [];
    out.variants = variants.length && JSON.stringify(variants) !== OLD_DEFAULT_VARIANTS_JSON ? variants : d.variants;
    return out;
}

function loadCache() {
    try {
        const cached = JSON.parse(localStorage.getItem(SETTINGS_CACHE_KEY));
        if (cached && cached.settings) return { settings: normalizeSettings(cached.settings), dirty: !!cached.dirty };
    } catch (e) {}
    // 예전 버전에서 저장해 둔 사이즈 목록이 있으면 이어받기
    const settings = defaultSettings();
    try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_VARIANT_KEY));
        if (Array.isArray(legacy) && legacy.length) settings.variants = normalizeSettings({ variants: legacy }).variants;
    } catch (e) {}
    return { settings, dirty: false };
}

function saveCache(settings, dirty) {
    try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ settings, dirty })); } catch (e) {}
}

function setSyncStatus(state) {
    if (!syncStatus) return;
    const text = {
        pending: '변경 사항 저장 대기 중…',
        saving: '☁️ 저장 중…',
        synced: '☁️ 모든 기기에 동기화됨',
        error: '⚠️ 동기화 실패 — 이 기기에는 저장됨, 나중에 자동으로 다시 시도합니다'
    }[state] || '';
    syncStatus.textContent = text;
    syncStatus.dataset.state = state || '';
}

function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (authCredentials) headers['Authorization'] = `Basic ${authCredentials}`;
    return headers;
}

// 화면의 현재 설정 읽기
function collectSettings() {
    return {
        srcset: srcsetCheck.checked,
        variants: readVariantRows().list
    };
}

// 설정을 화면에 반영 (저장은 트리거하지 않음)
function applySettings(settings) {
    applyingSettings = true;
    try {
        srcsetCheck.checked = settings.srcset;
        renderVariantRows(settings.variants);
        updateSrcsetEditorState();
        updateSettingsSummary();
    } finally {
        applyingSettings = false;
    }
}

// 사용자가 설정을 바꿨을 때 호출: 캐시에 즉시 저장 + 서버 저장 예약
function scheduleSync() {
    if (applyingSettings) return;
    saveCache(collectSettings(), true);
    setSyncStatus('pending');
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushSettings, SYNC_DELAY);
}

async function pushSettings() {
    syncTimer = null;
    if (!authCredentials) return;
    if (pushing) { pushQueued = true; return; }
    pushing = true;
    const settings = collectSettings();
    setSyncStatus('saving');
    try {
        const response = await fetch(SETTINGS_API, {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ settings })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // 저장하는 사이 또 바뀌었다면 dirty 유지 (다음 저장에서 반영됨)
        if (!syncTimer && !pushQueued) saveCache(settings, false);
        setSyncStatus(syncTimer || pushQueued ? 'pending' : 'synced');
    } catch (e) {
        console.warn('[SETTINGS_PUSH_FAILED]', e.message);
        setSyncStatus('error');
    } finally {
        pushing = false;
        if (pushQueued) { pushQueued = false; pushSettings(); }
    }
}

// 서버의 설정을 불러와 이 기기에 적용
async function pullSettings() {
    if (!authCredentials || pushing || syncTimer) return;
    if (settingsModal.open) return; // 편집 중에는 덮어쓰지 않음
    lastPullAt = Date.now();
    try {
        const response = await fetch(SETTINGS_API, { headers: authHeaders() });
        if (response.status === 401) { handleAuthFailure(); return; }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const cache = loadCache();

        // 아직 서버에 못 올린 변경이 있거나, 서버에 저장된 설정이 처음 없는 경우 → 이 기기 값을 올림
        if (cache.dirty || !data.settings) {
            await pushSettings();
            return;
        }

        const remote = normalizeSettings(data.settings);
        if (JSON.stringify(remote) !== JSON.stringify(normalizeSettings(collectSettings()))) {
            applySettings(remote);
        }
        saveCache(remote, false);
        setSyncStatus('synced');
    } catch (e) {
        console.warn('[SETTINGS_PULL_FAILED]', e.message);
        setSyncStatus('error');
    }
}

function handleAuthFailure() {
    authCredentials = null;
    localStorage.removeItem('auth');
    showLoginScreen();
    loginError.textContent = '아이디 또는 비밀번호가 올바르지 않습니다.';
    loginError.style.display = 'block';
}

// 다른 기기에서 바꾼 내용을, 이 창으로 돌아올 때 가져오기
function pullIfStale() {
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - lastPullAt < PULL_MIN_INTERVAL) return;
    pullSettings();
}
document.addEventListener('visibilitychange', pullIfStale);
window.addEventListener('focus', pullIfStale);

// 이름은 파일명에 들어가므로 영문 소문자/숫자/-/_ 만 허용
function sanitizeVariantName(value) {
    return value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
}

function renderVariantRows(list) {
    srcsetRows.innerHTML = '';
    list.forEach((v) => addVariantRow(v));
    onVariantsChanged();
}

function addVariantRow(v = { name: '', px: '' }) {
    const row = document.createElement('div');
    row.className = 'srcset-row';
    row.innerHTML = `
        <input type="text" class="variant-name" placeholder="예: small" maxlength="30" autocomplete="off" spellcheck="false">
        <input type="number" class="variant-px" placeholder="400" min="1" max="${MAX_VARIANT_PX}" step="1" inputmode="numeric">
        <button type="button" class="srcset-remove" aria-label="이 사이즈 삭제" title="삭제">✕</button>
    `;
    const nameInput = row.querySelector('.variant-name');
    const pxInput = row.querySelector('.variant-px');
    nameInput.value = v.name;
    pxInput.value = v.px;
    nameInput.addEventListener('input', () => {
        const clean = sanitizeVariantName(nameInput.value);
        if (clean !== nameInput.value) nameInput.value = clean;
        onVariantsChanged();
    });
    pxInput.addEventListener('input', onVariantsChanged);
    row.querySelector('.srcset-remove').addEventListener('click', () => {
        row.remove();
        onVariantsChanged();
    });
    // 입력칸에서 Enter를 눌러도 모달이 닫히지 않게
    [nameInput, pxInput].forEach((el) => el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault();
    }));
    srcsetRows.appendChild(row);
}

// 화면의 행을 읽어 유효한 목록과 오류를 반환
function readVariantRows() {
    const list = [];
    const errors = [];
    const seen = new Set();
    srcsetRows.querySelectorAll('.srcset-row').forEach((row) => {
        const name = row.querySelector('.variant-name').value.trim();
        const pxRaw = row.querySelector('.variant-px').value.trim();
        const px = Number(pxRaw);
        let invalid = false;
        if (!name && !pxRaw) { row.classList.remove('invalid'); return; } // 빈 행은 무시
        if (!name) { errors.push('이름이 비어 있는 사이즈가 있습니다.'); invalid = true; }
        else if (seen.has(name)) { errors.push(`이름 "${name}"이(가) 중복됩니다.`); invalid = true; }
        if (!Number.isInteger(px) || px < 1 || px > MAX_VARIANT_PX) {
            errors.push(`${name || '(이름 없음)'}: 가로 폭은 1~${MAX_VARIANT_PX} 사이 정수여야 합니다.`);
            invalid = true;
        }
        row.classList.toggle('invalid', invalid);
        if (!invalid) { seen.add(name); list.push({ name, px }); }
    });
    return { list, errors };
}

function getActiveVariants() {
    if (!srcsetCheck.checked) return [];
    return readVariantRows().list;
}

// 사용자가 사이즈 목록을 바꿨을 때: 화면 갱신 + 서버 저장 예약
function onVariantsChanged() {
    refreshVariantUI();
    scheduleSync();
}

function refreshVariantUI() {
    const { list, errors } = readVariantRows();
    srcsetError.hidden = errors.length === 0;
    srcsetError.innerHTML = errors.join('<br>');
    const ext = webpCheck.checked ? 'webp' : 'jpg';
    const note = webpCheck.checked ? '' : ' (확장자는 최종 파일 형식을 따름)';
    srcsetPreview.textContent = list.length
        ? `예: img-…-${list[0].name}.${ext} · 최종 이미지의 가로 폭보다 작은 사이즈만 생성${note}`
        : '생성할 사이즈가 없습니다.';
    addVariantBtn.disabled = srcsetRows.children.length >= MAX_VARIANTS;
    updateSettingsSummary();
}

function updateSrcsetEditorState() {
    srcsetEditor.classList.toggle('disabled', !srcsetCheck.checked);
    srcsetEditor.querySelectorAll('input, button').forEach((el) => { el.disabled = !srcsetCheck.checked; });
    if (srcsetCheck.checked) addVariantBtn.disabled = srcsetRows.children.length >= MAX_VARIANTS;
}

srcsetCheck.addEventListener('change', () => {
    updateSrcsetEditorState();
    updateSettingsSummary();
    scheduleSync();
});
webpCheck.addEventListener('change', refreshVariantUI); // 미리보기의 확장자만 갱신 (저장 안 함)

addVariantBtn.addEventListener('click', () => {
    if (srcsetRows.children.length >= MAX_VARIANTS) return;
    addVariantRow();
    srcsetRows.lastElementChild.querySelector('.variant-name').focus();
    onVariantsChanged();
});

resetVariantBtn.addEventListener('click', () => renderVariantRows(DEFAULT_VARIANTS.map((v) => ({ ...v }))));

// 현재 설정 요약 표시
function updateSettingsSummary() {
    const chips = [];
    if (webpCheck.checked) chips.push('<span class="chip">WebP 변환</span>');
    if (optimizeCheck.checked) chips.push('<span class="chip">최적화 1200px</span>');
    if (srcsetCheck.checked) {
        const n = readVariantRows().list.length;
        if (n) chips.push(`<span class="chip">srcset ${n}개</span>`);
    }
    if (adCheck.checked) chips.push('<span class="chip chip-ad">광고 → /ad/</span>');
    chips.push(limitCheck.checked
        ? '<span class="chip">용량 10MB 제한</span>'
        : '<span class="chip chip-warn">용량 제한 해제</span>');
    settingsSummary.innerHTML = `<span class="summary-label">⚙️ 현재 설정</span>${chips.join('')}`;
}

[webpCheck, optimizeCheck, adCheck, limitCheck].forEach((el) => el.addEventListener('change', updateSettingsSummary));

// 시작 시: 이 기기에 저장된 마지막 설정을 먼저 적용 (로그인 후 서버 값으로 갱신)
applySettings(loadCache().settings);

// 로그인
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    loginError.style.display = 'none';
    authCredentials = btoa(`${username}:${password}`);
    localStorage.setItem('auth', authCredentials);
    showMainApp();
});

logoutBtn.addEventListener('click', () => {
    authCredentials = null;
    localStorage.removeItem('auth');
    showLoginScreen();
});

function showMainApp() {
    loginContainer.style.display = 'none';
    mainContainer.style.display = 'flex';
    pullSettings();
}

function showLoginScreen() {
    loginContainer.style.display = 'flex';
    mainContainer.style.display = 'none';
    loginForm.reset();
    loginError.style.display = 'none';
}

window.addEventListener('load', () => {
    const savedAuth = localStorage.getItem('auth');
    if (savedAuth) {
        authCredentials = savedAuth;
        showMainApp();
    } else {
        showLoginScreen();
    }
});

uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
});

async function handleFiles(files) {
    if (files.length === 0) return;
    errorDiv.style.display = 'none';
    loading.style.display = 'block';
    if (resultsList.children.length === 0) {
        results.style.display = 'none';
    }
    for (const file of files) {
        await processOneFile(file);
        await sleep(300);
    }
    loading.style.display = 'none';
    fileInput.value = '';
}

function getExtension(name) {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

function replaceExtension(name, ext) {
    const i = name.lastIndexOf('.');
    return (i === -1 ? name : name.slice(0, i)) + '.' + ext;
}

// 일부 OS/브라우저는 AVIF 파일의 MIME 타입을 비워서 넘기므로 확장자로 보완
function getMimeType(file) {
    if (file.type) return file.type;
    const ext = getExtension(file.name);
    const map = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
    return map[ext] || '';
}

async function processOneFile(file) {
    const mime = getMimeType(file);
    if (!mime.startsWith('image/')) {
        showError(`"${file.name}"은(는) 이미지 파일이 아닙니다.`);
        return;
    }

    // 용량 제한: limitCheck가 체크된 경우에만 10MB 제한 적용
    if (limitCheck.checked && file.size > DEFAULT_MAX_FILE_SIZE) {
        showError(`"${file.name}"의 크기가 10MB를 초과합니다. (${formatFileSize(file.size)})\n용량 제한 해제 체크박스를 해제하면 제한 없이 업로드할 수 있습니다.`);
        return;
    }

    // 원본 MIME 타입이 비어 있으면(AVIF 등) 타입을 채운 사본 사용
    const original = file.type ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified });

    try {
        let processedFile = original;
        let wasOptimized = false;
        let wasConverted = false;

        // GIF도 변환 대상 (캔버스에는 첫 프레임만 그려지므로 애니메이션은 제거됨)
        const wantWebp = webpCheck.checked;
        const wantResize = optimizeCheck.checked;
        // 이미 WebP이고 리사이즈도 안 하면 다시 인코딩할 필요 없음
        const needWebpEncode = wantWebp && (mime !== 'image/webp' || wantResize);

        if (wantResize || needWebpEncode) {
            try {
                processedFile = await processImage(original, {
                    resize: wantResize,
                    format: wantWebp ? 'image/webp' : 'image/jpeg'
                });
                wasOptimized = wantResize;
                wasConverted = processedFile.type === 'image/webp' && mime !== 'image/webp';
                const reduction = ((1 - processedFile.size / file.size) * 100).toFixed(1);
                console.log(`[PROCESS_DONE] ${mime} -> ${processedFile.type} ${formatFileSize(file.size)} -> ${formatFileSize(processedFile.size)} (-${reduction}%)`);
            } catch (processError) {
                console.warn(`[PROCESS_FAILED] ${processError.message}, using original`);
                processedFile = original;
            }
        }

        const isAd = adCheck.checked;

        // srcset 변형은 원본 업로드와 동시에 준비 (인코딩과 네트워크 전송을 겹쳐 시간 단축)
        const variants = getActiveVariants();
        const buildPromise = variants.length
            ? buildVariants(original, processedFile, variants).catch((e) => {
                console.error('[VARIANT_BUILD_ERROR]', e.message);
                showError(`"${file.name}"의 srcset 사이즈 생성 실패: ${e.message}`);
                return { made: [], skipped: [] };
            })
            : Promise.resolve({ made: [], skipped: [] });

        const result = await uploadFile(processedFile, { isAd });
        result.originalName = file.name;
        result.optimized = wasOptimized;
        result.converted = wasConverted;

        // 변형 업로드: 같은 기본 이름 + "-이름" (최종 파일보다 작은 폭만, 동시에 여러 개)
        const { made, skipped } = await buildPromise;
        result.variantsSkipped = skipped;
        result.variants = result.baseName && made.length
            ? await uploadVariants(made, result.baseName, isAd, file.name)
            : [];

        addResult(result);

    } catch (error) {
        console.error('[UPLOAD_ERROR]', error.message);
        if (error.message.includes('401') || error.message.includes('Authentication')) {
            showError('인증이 만료되었습니다. 다시 로그인해주세요.');
            setTimeout(() => {
                authCredentials = null;
                localStorage.removeItem('auth');
                showLoginScreen();
            }, 2000);
        } else {
            showError(`"${file.name}" 업로드 실패: ${error.message}`);
        }
    }
}

// 이미지 디코딩 (createImageBitmap 우선, 없으면 <img> 사용)
async function decodeImage(file) {
    if ('createImageBitmap' in window) {
        const bitmap = await createImageBitmap(file);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => { try { bitmap.close(); } catch (e) {} } };
    }
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('이미지 로드 실패 (브라우저가 이 형식을 지원하지 않을 수 있음)'));
            el.src = url;
        });
        return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
    }
}

// 긴 폭을 maxSide 이하로 맞춘 크기 (비율 유지, 확대하지 않음)
function fitLongSide(width, height, maxSide) {
    const longSide = Math.max(width, height);
    if (longSide <= maxSide) return { width, height };
    const scale = maxSide / longSide;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// 캔버스에 그려서 지정 형식으로 인코딩. 브라우저가 그 형식을 못 만들면 null 반환.
async function encodeCanvas(source, width, height, format) {
    const canvas = document.createElement('canvas');
    try {
        canvas.width = width;
        canvas.height = height;
        // JPEG는 투명도가 없으므로 흰 배경, 그 외(WebP/PNG 등)는 투명도 유지
        const keepAlpha = format !== 'image/jpeg';
        const ctx = canvas.getContext('2d', { alpha: keepAlpha });
        if (!keepAlpha) {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, width, height);
        }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, width, height);
        const blob = await canvasToBlob(canvas, format, QUALITY);
        return blob.type === format ? blob : null;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

// 리사이즈 및 포맷 변환 (format: 'image/webp' | 'image/jpeg')
async function processImage(file, { resize, format }) {
    const decoded = await decodeImage(file);
    try {
        let { width, height } = decoded;
        if (width > MAX_CANVAS_SIZE * 2 || height > MAX_CANVAS_SIZE * 2) {
            throw new Error(`이미지가 너무 큽니다 (${width}×${height}px). 최대 ${MAX_CANVAS_SIZE * 2}px`);
        }
        if (resize) ({ width, height } = fitLongSide(width, height, MAX_DIMENSION));

        let outType = format;
        let blob = await encodeCanvas(decoded.source, width, height, format);

        // 일부 브라우저(구형 Safari 등)는 WebP 인코딩을 지원하지 않음 → JPEG로 대체
        if (!blob && format === 'image/webp') {
            console.warn('[WEBP_UNSUPPORTED] 이 브라우저는 WebP 인코딩을 지원하지 않아 JPEG로 저장합니다');
            outType = 'image/jpeg';
            blob = await encodeCanvas(decoded.source, width, height, outType);
        }
        if (!blob) throw new Error('이미지 인코딩 실패');

        const ext = outType === 'image/webp' ? 'webp' : 'jpg';
        const out = new File([blob], replaceExtension(file.name, ext), { type: outType, lastModified: Date.now() });
        out.imageWidth = width;
        out.imageHeight = height;
        return out;
    } finally {
        decoded.release();
    }
}

// srcset용 변형 파일 생성
// - 기준 폭 W = 최종 업로드 파일의 가로 폭 (최적화·WebP 변환이 끝난 결과)
// - 변형 폭이 W보다 작을 때만 생성. 같거나 크면 원본이 대신하므로 건너뜀 (복제본 방지)
// - 가로 폭을 설정 px와 정확히 맞추고 세로는 비율대로 (플러그인이 적는 NNNw 와 일치해야 함)
// - 원본 사진에서 직접 축소해 화질 손실 최소화, 형식은 최종 파일과 동일
// - 브라우저가 그 형식을 못 만들면(GIF, AVIF 등) 복사본으로 때우지 않고 건너뜀
async function buildVariants(original, finalFile, variants) {
    const decoded = await decodeImage(original);
    const targetType = finalFile.type;
    const finalWidth = finalFile.imageWidth || decoded.width;
    const finalHeight = finalFile.imageHeight || decoded.height;
    const made = [];
    const skipped = [];
    try {
        for (const v of variants) {
            if (v.px >= finalWidth) { skipped.push(v.name); continue; }
            const width = v.px;
            const height = Math.max(1, Math.round(finalHeight * width / finalWidth));
            const blob = await encodeCanvas(decoded.source, width, height, targetType);
            if (!blob) {
                console.warn(`[VARIANT_ENCODE_UNSUPPORTED] ${targetType} 인코딩 불가, -${v.name} 건너뜀`);
                skipped.push(v.name);
                continue;
            }
            made.push({ ...v, width, height, file: new File([blob], finalFile.name, { type: targetType }) });
        }
    } finally {
        decoded.release();
    }
    return { made, skipped };
}

// 변형 업로드 (동시에 최대 N개, 실패 시 1회 재시도, 인증 오류는 즉시 중단)
const VARIANT_UPLOAD_CONCURRENCY = 3;

async function uploadVariants(made, baseName, isAd, originalName) {
    const results = new Array(made.length).fill(null);
    let next = 0;
    let authError = null;

    const worker = async () => {
        while (next < made.length && !authError) {
            const i = next++;
            const v = made[i];
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const r = await uploadFile(v.file, { isAd, baseName, variant: v.name });
                    results[i] = { name: v.name, px: v.px, width: v.width, height: v.height, url: r.url, size: r.size };
                    break;
                } catch (e) {
                    if (e.message.includes('401')) { authError = e; break; }
                    if (attempt === 1) {
                        console.error('[VARIANT_UPLOAD_ERROR]', v.name, e.message);
                        showError(`"${originalName}"의 -${v.name} 사이즈 업로드 실패: ${e.message}`);
                    }
                }
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(VARIANT_UPLOAD_CONCURRENCY, made.length) }, worker));
    if (authError) throw authError;
    return results.filter(Boolean);
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Blob 변환 실패')), type, quality);
    });
}

async function uploadFile(file, { isAd, baseName, variant } = {}) {
    const formData = new FormData();
    // 텍스트 필드를 파일보다 먼저 넣어야 서버가 순서대로 읽기 쉬움
    formData.append('isAd', isAd ? 'true' : 'false');
    if (baseName) formData.append('baseName', baseName);
    if (variant) formData.append('variant', variant);
    formData.append('file', file);

    const headers = {};
    if (authCredentials) {
        headers['Authorization'] = `Basic ${authCredentials}`;
    }

    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers,
        body: formData
    });

    if (!response.ok) {
        if (response.status === 401) throw new Error('Authentication required (401)');
        let message = `Upload failed (${response.status})`;
        try { const error = await response.json(); message = error.error || message; } catch (e) {}
        throw new Error(message);
    }

    return await response.json();
}

// srcset 속성값 생성 (같은 가로폭은 하나만, 작은 순)
function buildSrcset(variants) {
    const byWidth = new Map();
    variants.forEach((v) => { if (!byWidth.has(v.width)) byWidth.set(v.width, v.url); });
    return [...byWidth.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([w, url]) => `${url} ${w}w`)
        .join(', ');
}

function addResult(data) {
    const div = document.createElement('div');
    div.className = 'result-item';

    const optimizedText = (data.converted ? ' 🔄 WebP 변환' : '') + (data.optimized ? ' ✨ 최적화됨' : '');
    const sizeText = data.size ? formatFileSize(data.size) : '';
    const adBadge = data.isAd
        ? `<span class="result-ad-badge">📁 /ad/ 폴더</span>`
        : '';
    const hasVariants = data.variants && data.variants.length > 0;

    div.innerHTML = `
        <div class="result-card">
            <div class="result-img-wrap">
                <img alt="업로드된 이미지" loading="lazy">
            </div>
            <div class="result-actions">
                <div class="result-meta">
                    ${adBadge}
                    <span class="result-filename"></span>
                    <span class="result-size">${sizeText}</span>
                </div>
                <button class="copy-btn copy-url-btn">
                    🔗 URL 복사
                </button>
                <button class="copy-btn copy-md-btn">
                    📝 마크다운 복사
                </button>
                ${hasVariants ? '<button class="copy-btn copy-srcset-btn">🧩 srcset 복사</button>' : ''}
            </div>
        </div>
        ${hasVariants ? '<div class="result-variants"><span class="variants-label">사이즈별 URL 복사</span><div class="variant-chips"></div></div>' : ''}
    `;

    div.querySelector('.result-filename').textContent = data.filename + optimizedText;

    // img src 직접 설정 (innerHTML에 URL 넣으면 특수문자에서 깨짐)
    const img = div.querySelector('img');
    img.src = data.url;
    img.onerror = () => {
        img.style.display = 'none';
        img.parentElement.style.background = '#ddd';
    };

    // 버튼 이벤트 직접 등록
    div.querySelector('.copy-url-btn').addEventListener('click', function() {
        copyText(data.url, this, 'URL');
    });
    div.querySelector('.copy-md-btn').addEventListener('click', function() {
        copyText(data.markdown, this, '마크다운');
    });

    if (hasVariants) {
        const srcset = buildSrcset(data.variants);
        div.querySelector('.copy-srcset-btn').addEventListener('click', function() {
            copyText(srcset, this, 'srcset');
        });
        const chips = div.querySelector('.variant-chips');
        data.variants.forEach((v) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'variant-chip';
            chip.title = `${v.url}\n${v.width}×${v.height}px · ${formatFileSize(v.size || 0)}`;
            const label = `-${v.name} · ${v.width}×${v.height}`;
            chip.textContent = label;
            chip.addEventListener('click', () => {
                navigator.clipboard.writeText(v.url).then(() => {
                    chip.textContent = '✅ 복사됨';
                    chip.classList.add('copied');
                    setTimeout(() => { chip.textContent = label; chip.classList.remove('copied'); }, 1500);
                }).catch(() => alert('복사에 실패했습니다.'));
            });
            chips.appendChild(chip);
        });
    }

    if (data.variantsSkipped && data.variantsSkipped.length) {
        const note = document.createElement('p');
        note.className = 'variants-skipped';
        note.textContent = `이미지 폭 이하라 생략한 사이즈: ${data.variantsSkipped.map((n) => '-' + n).join(', ')}`;
        div.appendChild(note);
    }

    resultsList.insertBefore(div, resultsList.firstChild);
    results.style.display = 'block';
}

function copyText(text, button, type) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = button.textContent;
        button.textContent = `✅ ${type} 복사됨!`;
        button.classList.add('copied');
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 2000);
    }).catch(() => {
        alert('복사에 실패했습니다.');
    });
}

function showError(message) {
    errorDiv.innerHTML = message.replace(/\n/g, '<br>');
    errorDiv.style.display = 'block';
    setTimeout(() => errorDiv.style.display = 'none', 5000);
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('[APP_READY] FTP Image Uploader');
