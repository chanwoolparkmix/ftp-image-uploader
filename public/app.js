const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const loading = document.getElementById('loading');
const results = document.getElementById('results');
const resultsList = document.getElementById('resultsList');
const errorDiv = document.getElementById('error');
const optimizeCheck = document.getElementById('optimizeCheck');

const API_ENDPOINT = '/api/upload';

// 기본 최적화 설정
const MAX_DIMENSION = 1200;
const QUALITY = 0.85;

// 메모리 안전 설정
const MAX_CANVAS_SIZE = 4096; // 안전한 최대 캔버스 크기
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

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

    // 🔥 한 번에 하나씩 순차 처리 (메모리 보호)
    for (const file of files) {
        await processOneFile(file);
        
        // 각 파일 처리 후 약간의 대기 시간 (GC 시간 확보)
        await sleep(100);
    }

    loading.style.display = 'none';
    fileInput.value = '';
}

// 파일 하나씩 처리
async function processOneFile(file) {
    if (!file.type.startsWith('image/')) {
        showError(`❌ "${file.name}"은(는) 이미지 파일이 아닙니다.`);
        return;
    }

    if (file.size > MAX_FILE_SIZE) {
        showError(`❌ "${file.name}"의 크기가 10MB를 초과합니다. (${formatFileSize(file.size)})`);
        return;
    }

    try {
        console.log(`📤 처리 시작: ${file.name} (${formatFileSize(file.size)})`);
        
        let processedFile = file;
        let wasOptimized = false;
        
        if (optimizeCheck.checked) {
            console.log(`🔧 최적화 중: ${file.name}`);
            
            try {
                processedFile = await optimizeImageSafely(file);
                wasOptimized = true;
                
                const reduction = ((1 - processedFile.size / file.size) * 100).toFixed(1);
                console.log(`✅ 최적화 완료: ${formatFileSize(file.size)} → ${formatFileSize(processedFile.size)} (-${reduction}%)`);
            } catch (optimizeError) {
                console.warn(`⚠️ 최적화 실패, 원본 업로드: ${optimizeError.message}`);
                // 최적화 실패해도 원본으로 업로드 진행
            }
        }
        
        const result = await uploadFile(processedFile, file.name, wasOptimized);
        addResult(result);
        
    } catch (error) {
        console.error('Upload error:', error);
        showError(`❌ "${file.name}" 업로드 실패: ${error.message}`);
    }
}

// 메모리 안전 이미지 최적화
async function optimizeImageSafely(file) {
    return new Promise((resolve, reject) => {
        // 1단계: createImageBitmap으로 메모리 효율적 디코딩
        const useBitmap = 'createImageBitmap' in window;
        
        if (useBitmap) {
            // 최신 브라우저 (Chrome, Edge, Firefox)
            optimizeWithImageBitmap(file).then(resolve).catch(reject);
        } else {
            // 구형 브라우저 (Safari) - 폴백
            optimizeWithImage(file).then(resolve).catch(reject);
        }
    });
}

// createImageBitmap 사용 (메모리 효율적)
async function optimizeWithImageBitmap(file) {
    let bitmap = null;
    let canvas = null;
    let ctx = null;
    
    try {
        // ImageBitmap 생성 (메모리 효율적)
        bitmap = await createImageBitmap(file);
        
        let width = bitmap.width;
        let height = bitmap.height;
        
        // 원본이 너무 크면 거부
        if (width > MAX_CANVAS_SIZE * 2 || height > MAX_CANVAS_SIZE * 2) {
            throw new Error(`이미지가 너무 큽니다 (${width}×${height}px). 최대 ${MAX_CANVAS_SIZE * 2}px`);
        }
        
        // 크기 조정 계산
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
            if (width > height) {
                height = Math.round((height * MAX_DIMENSION) / width);
                width = MAX_DIMENSION;
            } else {
                width = Math.round((width * MAX_DIMENSION) / height);
                height = MAX_DIMENSION;
            }
        }
        
        // Canvas 생성
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        ctx = canvas.getContext('2d', { 
            alpha: false, // 알파 채널 비활성화로 메모리 절약
            desynchronized: true // 성능 향상
        });
        
        // 배경을 흰색으로 (PNG 투명도 제거)
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        
        // ImageBitmap 그리기
        ctx.drawImage(bitmap, 0, 0, width, height);
        
        // Blob 변환
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(
                (b) => b ? resolve(b) : reject(new Error('Blob 변환 실패')),
                'image/jpeg',
                QUALITY
            );
        });
        
        // File 객체 생성
        const optimizedFile = new File([blob], file.name, {
            type: 'image/jpeg',
            lastModified: Date.now()
        });
        
        return optimizedFile;
        
    } finally {
        // 메모리 해제
        if (bitmap) bitmap.close();
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
        bitmap = null;
        canvas = null;
        ctx = null;
    }
}

// Image 사용 (구형 브라우저 폴백)
async function optimizeWithImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        let canvas = null;
        let ctx = null;
        
        const cleanup = () => {
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
            if (img.src) {
                URL.revokeObjectURL(img.src);
            }
            canvas = null;
            ctx = null;
            img.onload = null;
            img.onerror = null;
        };
        
        img.onload = () => {
            try {
                let width = img.width;
                let height = img.height;
                
                if (width > MAX_CANVAS_SIZE * 2 || height > MAX_CANVAS_SIZE * 2) {
                    cleanup();
                    reject(new Error(`이미지가 너무 큽니다 (${width}×${height}px)`));
                    return;
                }
                
                if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                    if (width > height) {
                        height = Math.round((height * MAX_DIMENSION) / width);
                        width = MAX_DIMENSION;
                    } else {
                        width = Math.round((width * MAX_DIMENSION) / height);
                        height = MAX_DIMENSION;
                    }
                }
                
                canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                ctx = canvas.getContext('2d', { alpha: false });
                
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                
                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            const optimizedFile = new File([blob], file.name, {
                                type: 'image/jpeg',
                                lastModified: Date.now()
                            });
                            cleanup();
                            resolve(optimizedFile);
                        } else {
                            cleanup();
                            reject(new Error('Blob 변환 실패'));
                        }
                    },
                    'image/jpeg',
                    QUALITY
                );
                
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        
        img.onerror = () => {
            cleanup();
            reject(new Error('이미지 로드 실패'));
        };
        
        img.src = URL.createObjectURL(file);
    });
}

async function uploadFile(file, originalName, wasOptimized) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || error.details || 'Upload failed');
    }

    const data = await response.json();
    return {
        ...data,
        originalName: originalName,
        originalSize: file.size,
        optimized: wasOptimized
    };
}

function addResult(data) {
    const div = document.createElement('div');
    div.className = 'result-item';
    
    const optimizedText = data.optimized ? ' ✨ 최적화됨' : '';
    const sizeText = data.size ? formatFileSize(data.size) : '';
    
    div.innerHTML = `
        <div class="result-preview">
            <img src="${data.url}" alt="Uploaded image" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect fill=%22%23ddd%22 width=%22100%22 height=%22100%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23999%22%3E이미지%3C/text%3E%3C/svg%3E'">
            <div class="result-info">
                <h4>${data.filename}${optimizedText}</h4>
                <div class="file-size">크기: ${sizeText}</div>
            </div>
        </div>

        <div class="url-box">
            <label>이미지 URL:</label>
            <div class="url-text">${data.url}</div>
        </div>

        <div class="url-box">
            <label>마크다운:</label>
            <div class="url-text">${data.markdown}</div>
        </div>

        <div class="button-group">
            <button class="copy-btn" onclick="copyText('${escapeQuotes(data.url)}', this, 'URL')">
                📋 URL 복사
            </button>
            <button class="copy-btn" onclick="copyText('${escapeQuotes(data.markdown)}', this, '마크다운')">
                📝 마크다운 복사
            </button>
        </div>
    `;
    
    resultsList.insertBefore(div, resultsList.firstChild);
    results.style.display = 'block';
}

window.copyText = function(text, button, type) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = button.textContent;
        button.textContent = `✅ ${type} 복사됨!`;
        button.classList.add('copied');
        
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 2000);
    }).catch(err => {
        console.error('복사 실패:', err);
        alert('복사에 실패했습니다.');
    });
}

function showError(message) {
    errorDiv.textContent = message;
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

function escapeQuotes(str) {
    return str.replace(/'/g, "\\'");
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('🚀 FTP Image Uploader 준비 완료! (메모리 안전 모드)');
console.log(`📐 최적화: 최대 ${MAX_DIMENSION}px, 품질 ${Math.round(QUALITY * 100)}%`);
console.log(`🛡️ createImageBitmap 지원: ${('createImageBitmap' in window) ? '✅' : '❌ (폴백 모드)'}`);