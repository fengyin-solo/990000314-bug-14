/**
 * Convert a flat category list ({id, parent_id, ...}) into an ordered,
 * depth-annotated tree list. Roots are sorted first; input order is
 * otherwise preserved (the API already sorts by parent/name).
 */
export function buildCategoryTree(categories) {
  const childrenOf = new Map()
  for (const cat of categories) {
    const key = cat.parent_id ?? 0
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key).push(cat)
  }
  const out = []
  const walk = (list, depth) => {
    for (const cat of list) {
      out.push({ ...cat, depth })
      walk(childrenOf.get(cat.id) || [], depth + 1)
    }
  }
  walk(childrenOf.get(0) || [], 0)
  return out
}
