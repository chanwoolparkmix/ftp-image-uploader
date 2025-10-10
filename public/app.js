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
    
    // 기존 결과 유지 (누적 표시)
    if (resultsList.children.length === 0) {
        results.style.display = 'none';
    }

    const uploadResults = [];

    for (const file of files) {
        if (!file.type.startsWith('image/')) {
            showError(`❌ "${file.name}"은(는) 이미지 파일이 아닙니다.`);
            continue;
        }

        if (file.size > 10 * 1024 * 1024) {
            showError(`❌ "${file.name}"의 크기가 10MB를 초과합니다. (${formatFileSize(file.size)})`);
            continue;
        }

        try {
            console.log(`📤 업로드 시작: ${file.name}`);
            
            // Canvas API로 이미지 최적화
            let processedFile = file;
            let wasOptimized = false;
            
            if (optimizeCheck.checked) {
                console.log(`🔧 최적화 중: ${file.name}`);
                processedFile = await optimizeImage(file);
                wasOptimized = true;
                console.log(`✅ 최적화 완료: ${formatFileSize(file.size)} → ${formatFileSize(processedFile.size)}`);
            }
            
            const result = await uploadFile(processedFile, file.name, wasOptimized);
            uploadResults.push(result);
            
        } catch (error) {
            console.error('Upload error:', error);
            showError(`❌ "${file.name}" 업로드 실패: ${error.message}`);
        }
    }

    loading.style.display = 'none';

    if (uploadResults.length > 0) {
        results.style.display = 'block';
        uploadResults.forEach(result => addResult(result));
    }

    fileInput.value = '';
}

// Canvas API를 사용한 이미지 최적화
async function optimizeImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        img.onload = () => {
            try {
                let width = img.width;
                let height = img.height;
                
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
                
                // Canvas 크기 설정
                canvas.width = width;
                canvas.height = height;
                
                // 이미지 그리기
                ctx.drawImage(img, 0, 0, width, height);
                
                // Blob으로 변환
                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            // File 객체로 변환
                            const optimizedFile = new File(
                                [blob], 
                                file.name, 
                                { 
                                    type: file.type,
                                    lastModified: Date.now()
                                }
                            );
                            resolve(optimizedFile);
                        } else {
                            reject(new Error('이미지 변환 실패'));
                        }
                    },
                    file.type,
                    QUALITY
                );
                
            } catch (error) {
                reject(error);
            }
        };
        
        img.onerror = () => {
            reject(new Error('이미지 로드 실패'));
        };
        
        // 이미지 로드
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
            <img src="${data.url}" alt="Uploaded image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect fill=%22%23ddd%22 width=%22100%22 height=%22100%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23999%22%3E이미지%3C/text%3E%3C/svg%3E'">
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
    
    // 새 결과를 맨 위에 추가 (최신 항목이 위로)
    resultsList.insertBefore(div, resultsList.firstChild);
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
    
    // 3초 후 자동으로 에러 메시지 숨김
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 3000);
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

console.log('🚀 FTP Image Uploader 준비 완료!');
console.log(`📐 최적화 설정: 최대 ${MAX_DIMENSION}px, 품질 ${Math.round(QUALITY * 100)}%`);