<template>
  <div>
    <div
      class="category-item"
      :class="{ active: linksStore.selectedCategory === category.id }"
      :style="{ paddingLeft: 12 + depth * 16 + 'px' }"
      @click="linksStore.setCategory(category.id)"
    >
      <span class="category-color" :style="{ backgroundColor: category.color }"></span>
      <span class="category-name" :title="category.name">{{ category.name }}</span>
      <span class="category-count">{{ category.link_count }}</span>
      <el-dropdown trigger="click" @command="(cmd) => emit('command', cmd, category)" @click.stop>
        <el-button text size="small" class="category-more" @click.stop>
          <el-icon><MoreFilled /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="edit">编辑</el-dropdown-item>
            <el-dropdown-item command="add-child">添加子分类</el-dropdown-item>
            <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <CategoryNode
      v-for="child in category.children"
      :key="child.id"
      :category="child"
      :depth="depth + 1"
      @command="(cmd, cat) => emit('command', cmd, cat)"
    />
  </div>
</template>

<script setup>
import { useLinksStore } from '../stores/links'

defineProps({
  category: { type: Object, required: true },
  depth: { type: Number, default: 0 },
})
const emit = defineEmits(['command'])
const linksStore = useLinksStore()
</script>

<style scoped>
.category-item {
  display: flex;
  align-items: center;
  padding-top: 8px;
  padding-bottom: 8px;
  padding-right: 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s;
  gap: 8px;
}

.category-item:hover {
  background-color: #f5f7fa;
}

.category-item.active {
  background-color: #ecf5ff;
  color: #409eff;
}

.category-color {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex-shrink: 0;
}

.category-name {
  flex: 1;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-count {
  font-size: 12px;
  color: #909399;
  background: #f0f2f5;
  padding: 2px 8px;
  border-radius: 10px;
}

.category-more {
  opacity: 0;
  transition: opacity 0.2s;
}

.category-item:hover .category-more {
  opacity: 1;
}
</style>
