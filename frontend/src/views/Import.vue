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
        <p class="hint">Edge、Firefox 导出的 HTML 书签同样支持；文件夹层级会原样保留为分类，重复地址按规范化地址判定，重复导入只会补齐缺失的书签。</p>
      </div>

      <el-upload
        class="upload-area"
        drag
        :auto-upload="false"
        :limit="1"
        accept=".html,.htm"
        :on-change="handleFileChange"
        :on-exceed="handleExceed"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">
          拖拽文件到此处，或 <em>点击上传</em>
        </div>
        <template #tip>
          <div class="el-upload__tip">仅支持 Chrome / Edge / Firefox 导出的 HTML 书签文件，最大 10MB</div>
        </template>
      </el-upload>

      <div class="upload-actions" v-if="selectedFile">
        <p class="file-name">已选择: {{ selectedFile.name }}</p>
        <el-button type="primary" :loading="importing" @click="handleImport" size="large">
          开始导入
        </el-button>
      </div>

      <div v-if="importResult" class="result-block">
        <el-result
          :icon="resultIcon"
          :title="importResult.message"
          :sub-title="`文件解析 ${importResult.parsed + importResult.rejected} 条；新增 ${importResult.imported} 条，跳过 ${importResult.skipped} 条，失败 ${importResult.failed} 条（合计 ${importResult.total} 条）`"
        >
          <template #extra>
            <el-button type="primary" @click="goHome">查看链接</el-button>
            <el-button @click="resetImport">继续导入</el-button>
          </template>
        </el-result>

        <el-tabs v-model="activeTab" class="detail-tabs">
          <el-tab-pane name="failed">
            <template #label>
              失败明细 <el-badge :value="importResult.failed" :hidden="importResult.failed === 0" type="danger" />
            </template>
            <el-empty v-if="failedDetails.length === 0" description="没有失败的书签" :image-size="60" />
            <el-table v-else :data="failedDetails" size="small" max-height="360">
              <el-table-column label="第几条" prop="index" width="70" />
              <el-table-column label="行号" prop="line" width="70" />
              <el-table-column label="标题" prop="title" min-width="140" show-overflow-tooltip />
              <el-table-column label="地址" prop="url" min-width="160" show-overflow-tooltip />
              <el-table-column label="失败原因" prop="reason" min-width="200" show-overflow-tooltip />
            </el-table>
          </el-tab-pane>

          <el-tab-pane name="all">
            <template #label>全部明细 ({{ importResult.details.length }})</template>
            <el-table :data="importResult.details" size="small" max-height="360">
              <el-table-column label="#" prop="index" width="55" />
              <el-table-column label="行号" prop="line" width="60" />
              <el-table-column label="状态" width="90">
                <template #default="{ row }">
                  <el-tag v-if="row.status === 'imported'" type="success" size="small">已导入</el-tag>
                  <el-tag v-else-if="row.status === 'skipped'" type="info" size="small">跳过</el-tag>
                  <el-tag v-else type="danger" size="small">失败</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="标题" prop="title" min-width="130" show-overflow-tooltip />
              <el-table-column label="分类路径" prop="category_path" min-width="130" show-overflow-tooltip />
              <el-table-column label="说明 / 原因" prop="reason" min-width="180" show-overflow-tooltip />
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { importApi } from '../api'

const router = useRouter()
const selectedFile = ref(null)
const importing = ref(false)
const importResult = ref(null)
const activeTab = ref('failed')

const failedDetails = computed(() =>
  (importResult.value?.details || []).filter((d) => d.status === 'failed')
)

const resultIcon = computed(() => {
  if (!importResult.value) return 'info'
  if (importResult.value.failed > 0 && importResult.value.imported === 0) return 'error'
  if (importResult.value.failed > 0) return 'warning'
  return 'success'
})

function handleFileChange(file) {
  selectedFile.value = file.raw
}

function handleExceed() {
  ElMessage.warning('只能上传一个文件，请先移除已选文件')
}

async function handleImport() {
  if (!selectedFile.value) return

  importing.value = true
  try {
    const response = await importApi.importBookmarks(selectedFile.value)
    importResult.value = response.data
    activeTab.value = response.data.failed > 0 ? 'failed' : 'all'
    if (response.data.imported > 0) {
      ElMessage.success(`成功导入 ${response.data.imported} 条书签`)
    }
    if (response.data.failed > 0) {
      ElMessage.warning(`${response.data.failed} 条书签导入失败，请查看失败明细`)
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '导入失败，请检查文件格式后重试')
  } finally {
    importing.value = false
  }
}

function goHome() {
  router.push('/')
}

function resetImport() {
  selectedFile.value = null
  importResult.value = null
}
</script>

<style scoped>
.import-container {
  max-width: 820px;
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

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #909399;
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

.result-block {
  margin-top: 8px;
}

.detail-tabs {
  margin-top: -10px;
}
</style>
