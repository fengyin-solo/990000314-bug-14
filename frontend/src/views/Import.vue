<template>
  <div class="import-container">
    <el-card>
      <template #header>
        <div class="card-header">
          <el-button @click="$router.push('/')" text>
            <el-icon><ArrowLeft /></el-icon>
            返回
          </el-button>
          <h2>导入浏览器书签</h2>
        </div>
      </template>

      <div class="import-instructions">
        <h3>如何导出 Chrome 书签：</h3>
        <ol>
          <li>打开 Chrome 浏览器，点击右上角菜单 (三个点)</li>
          <li>选择 "书签和清单" > "书签管理器"</li>
          <li>在书签管理器中，点击右上角菜单 (三个点)</li>
          <li>选择 "导出书签"</li>
          <li>保存 HTML 文件后，上传到此处</li>
        </ol>
      </div>

      <el-upload
        ref="uploadRef"
        class="upload-area"
        drag
        :auto-upload="false"
        :limit="1"
        accept=".html,.htm"
        :on-change="handleFileChange"
        :on-exceed="handleExceed"
        :on-remove="handleRemove"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">
          拖拽文件到此处，或 <em>点击上传</em>
        </div>
        <template #tip>
          <div class="el-upload__tip">仅支持 Chrome/Firefox 书签导出的 HTML 文件，最大 10MB</div>
        </template>
      </el-upload>

      <div class="upload-actions" v-if="selectedFile">
        <p class="file-name">已选择: {{ selectedFile.name }}</p>
        <el-button type="primary" :loading="importing" @click="handleImport" size="large">
          开始导入
        </el-button>
      </div>

      <el-result
        v-if="importResult"
        :icon="resultIcon"
        :title="importResult.message"
        :sub-title="resultSubtitle"
      >
        <template #extra>
          <el-button type="primary" @click="$router.push('/')">查看链接</el-button>
          <el-button @click="resetImport">继续导入</el-button>
        </template>
      </el-result>

      <div v-if="importResult && hasDetails" class="import-details">
        <el-tabs v-model="activeTab">
          <el-tab-pane :label="`成功 ${importResult.imported_count} 条`" name="imported">
            <el-scrollbar max-height="360px">
              <ul v-if="importResult.details.imported.length" class="detail-list success">
                <li v-for="item in importResult.details.imported" :key="'ok-' + item.index">
                  <span class="item-index">第 {{ item.index }} 条</span>
                  <span class="item-title">{{ item.title }}</span>
                  <span class="item-path" v-if="item.categoryPath && item.categoryPath.length">
                    → {{ item.categoryPath.join(' / ') }}
                  </span>
                  <el-link :href="item.url" target="_blank" class="item-url" :underline="false">{{ item.url }}</el-link>
                </li>
              </ul>
              <el-empty v-else description="没有成功导入的书签" :image-size="60" />
            </el-scrollbar>
          </el-tab-pane>

          <el-tab-pane :label="`跳过 ${importResult.skipped_count} 条`" name="skipped">
            <el-scrollbar max-height="360px">
              <ul v-if="importResult.details.skipped.length" class="detail-list skipped">
                <li v-for="item in importResult.details.skipped" :key="'skip-' + item.index">
                  <span class="item-index">第 {{ item.index }} 条</span>
                  <span class="item-title">{{ item.title }}</span>
                  <el-tag size="small" type="info">{{ item.reason }}</el-tag>
                  <span class="item-url">{{ item.url }}</span>
                </li>
              </ul>
              <el-empty v-else description="没有跳过的书签" :image-size="60" />
            </el-scrollbar>
          </el-tab-pane>

          <el-tab-pane :label="`失败 ${importResult.failed_count} 条`" name="failures">
            <el-scrollbar max-height="360px">
              <ul v-if="importResult.details.failures.length" class="detail-list failed">
                <li v-for="item in importResult.details.failures" :key="'fail-' + item.index">
                  <span class="item-index">第 {{ item.index }} 条<template v-if="item.line">（文件第 {{ item.line }} 行）</template></span>
                  <span class="item-title">{{ item.title || '（无法识别标题）' }}</span>
                  <el-tag size="small" type="danger">{{ item.reason }}</el-tag>
                  <span class="item-url" v-if="item.url">{{ item.url }}</span>
                </li>
              </ul>
              <el-empty v-else description="没有失败的书签" :image-size="60" />
            </el-scrollbar>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { importApi } from '../api'

const uploadRef = ref(null)
const selectedFile = ref(null)
const importing = ref(false)
const importResult = ref(null)
const activeTab = ref('imported')

const hasDetails = computed(
  () => importResult.value && importResult.value.details
)

const resultIcon = computed(() => {
  if (!importResult.value) return 'info'
  if (importResult.value.failed_count > 0 && importResult.value.imported_count === 0) return 'error'
  if (importResult.value.failed_count > 0 || importResult.value.skipped_count > 0) return 'warning'
  return 'success'
})

const resultSubtitle = computed(() => {
  if (!importResult.value) return ''
  const r = importResult.value
  return `文件中共识别 ${r.total} 条：成功 ${r.imported_count} 条，跳过 ${r.skipped_count} 条，失败 ${r.failed_count} 条`
})

function handleFileChange(file) {
  selectedFile.value = file.raw
  importResult.value = null
}

function handleRemove() {
  selectedFile.value = null
}

function handleExceed() {
  ElMessage.warning('只能上传一个文件，请先移除已选文件')
}

async function handleImport() {
  if (!selectedFile.value) return

  importing.value = true
  importResult.value = null
  try {
    const response = await importApi.importBookmarks(selectedFile.value)
    importResult.value = normalizeResult(response.data)
    activeTab.value = importResult.value.imported_count > 0 ? 'imported' : 'failures'
    if (importResult.value.imported_count > 0) {
      ElMessage.success(`成功导入 ${importResult.value.imported_count} 条书签`)
    } else {
      ElMessage.warning('没有书签被导入，请查看失败明细')
    }
  } catch (err) {
    // Surface the server's explanation (file too large, empty file, ...).
    ElMessage.error(err.response?.data?.error || err.message || '导入失败')
  } finally {
    importing.value = false
  }
}

// Accept both the new detailed response and any older-shaped response.
function normalizeResult(data) {
  const details = data.details || { imported: [], skipped: [], failures: [] }
  const result = {
    total: data.total ?? 0,
    imported_count: data.imported_count ?? data.imported ?? details.imported.length,
    skipped_count: data.skipped_count ?? data.skipped ?? details.skipped.length,
    failed_count: data.failed_count ?? data.failed ?? details.failures.length,
    message: data.message || '',
    details: {
      imported: details.imported || [],
      skipped: details.skipped || [],
      failures: details.failures || [],
    },
  }
  // Counts always reflect the detail rows, so summary and list can't drift.
  result.total = result.details.imported.length + result.details.skipped.length + result.details.failures.length
  return result
}

function resetImport() {
  selectedFile.value = null
  importResult.value = null
  uploadRef.value?.clearFiles()
}
</script>

<style scoped>
.import-container {
  max-width: 800px;
  margin: 40px auto;
  padding: 0 20px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.card-header h2 {
  margin: 0;
}

.import-instructions {
  background: #f5f7fa;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 24px;
}

.import-instructions h3 {
  margin: 0 0 12px 0;
  font-size: 15px;
  color: #303133;
}

.import-instructions ol {
  margin: 0;
  padding-left: 20px;
  color: #606266;
  font-size: 14px;
  line-height: 1.8;
}

.upload-area {
  margin-bottom: 20px;
}

.upload-actions {
  text-align: center;
  padding: 16px 0;
}

.file-name {
  margin-bottom: 12px;
  color: #606266;
}

.import-details {
  margin-top: 8px;
}

.detail-list {
  list-style: none;
  margin: 0;
  padding: 4px 8px;
}

.detail-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  border-bottom: 1px solid #ebeef5;
  font-size: 13px;
}

.item-index {
  flex-shrink: 0;
  font-weight: 600;
  color: #303133;
  min-width: 96px;
}

.item-title {
  color: #303133;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-path {
  color: #67c23a;
  font-size: 12px;
}

.item-url {
  flex-basis: 100%;
  color: #909399;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-list.skipped .item-index {
  color: #909399;
}

.detail-list.failed .item-index {
  color: #f56c6c;
}
</style>
