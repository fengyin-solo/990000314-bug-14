<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    :title="isEdit ? '编辑链接' : '添加链接'"
    width="500px"
    @close="resetForm"
  >
    <el-form :model="form" :rules="rules" ref="formRef" label-width="80px">
      <el-form-item label="URL" prop="url">
        <el-input v-model="form.url" placeholder="https://example.com" />
      </el-form-item>

      <el-form-item label="标题" prop="title">
        <el-input v-model="form.title" placeholder="链接标题" />
      </el-form-item>

      <el-form-item label="描述">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="3"
          placeholder="链接描述 (可选)"
        />
      </el-form-item>

      <el-form-item label="分类">
        <el-select v-model="form.category_id" placeholder="选择分类" clearable style="width: 100%">
          <el-option
            v-for="cat in linksStore.flatCategoryTree"
            :key="cat.id"
            :label="cat.fullName"
            :value="cat.id"
          >
            <span :style="{ paddingLeft: cat.depth * 14 + 'px' }">
              <el-tag :color="cat.color" effect="dark" size="small" style="margin-right: 8px">
                &nbsp;
              </el-tag>
              {{ cat.fullName }}
            </span>
          </el-option>
        </el-select>
      </el-form-item>

      <el-form-item label="标签">
        <el-input v-model="form.tagsInput" placeholder="用逗号分隔多个标签" />
        <div class="tag-hint">例如: 前端, Vue, 教程</div>
      </el-form-item>

      <el-form-item label="稍后阅读">
        <el-checkbox v-model="form.is_read_later">加入稍后阅读清单</el-checkbox>
      </el-form-item>

      <el-form-item label="回顾日期" v-if="form.is_read_later">
        <el-date-picker
          v-model="form.review_date"
          type="date"
          placeholder="选择回顾日期（可选）"
          style="width: 100%"
          :disabled-date="disabledDate"
        />
        <div class="quick-dates">
          <el-button size="small" @click="setQuickDate(1)">明天</el-button>
          <el-button size="small" @click="setQuickDate(3)">3天后</el-button>
          <el-button size="small" @click="setQuickDate(7)">1周后</el-button>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useLinksStore } from '../stores/links'

const props = defineProps({
  visible: Boolean,
  link: Object,
})

const emit = defineEmits(['update:visible', 'saved'])

const linksStore = useLinksStore()
const formRef = ref(null)
const saving = ref(false)

const isEdit = computed(() => !!props.link?.id)

const form = reactive({
  url: '',
  title: '',
  description: '',
  category_id: null,
  tagsInput: '',
  is_read_later: false,
  review_date: null,
})

const rules = {
  url: [
    { required: true, message: '请输入 URL', trigger: 'blur' },
    { type: 'url', message: '请输入有效的 URL', trigger: 'blur' },
  ],
  title: [{ required: true, message: '请输入标题', trigger: 'blur' }],
}

watch(
  () => props.visible,
  (val) => {
    if (val && props.link) {
      form.url = props.link.url
      form.title = props.link.title
      form.description = props.link.description || ''
      form.category_id = props.link.category_id
      form.tagsInput = props.link.tags?.join(', ') || ''
      form.is_read_later = props.link.is_read_later || false
      form.review_date = props.link.review_date ? new Date(props.link.review_date) : null
    } else if (val) {
      resetForm()
    }
  }
)

function resetForm() {
  form.url = ''
  form.title = ''
  form.description = ''
  form.category_id = null
  form.tagsInput = ''
  form.is_read_later = false
  form.review_date = null
  formRef.value?.resetFields()
}

function disabledDate(time) {
  return time.getTime() < Date.now() - 86400000
}

function setQuickDate(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  form.review_date = date
}

async function handleSave() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  saving.value = true
  try {
    const tags = form.tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t)

    const data = {
      url: form.url,
      title: form.title,
      description: form.description,
      category_id: form.category_id,
      tags,
      is_read_later: form.is_read_later,
      review_date: form.review_date ? form.review_date.toISOString().split('T')[0] : null,
    }

    if (isEdit.value) {
      await linksStore.updateLink(props.link.id, data)
      ElMessage.success('更新成功')
    } else {
      await linksStore.createLink(data)
      ElMessage.success('添加成功')
    }

    emit('saved')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '操作失败')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.tag-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.quick-dates {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
