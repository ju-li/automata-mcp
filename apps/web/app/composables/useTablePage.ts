import { watchDebounced } from '@vueuse/core'

/**
 * One page of a server-paged table, with its search box and its column sort.
 *
 * Every dashboard table — chats, messages, contacts — asks the server for one
 * page and renders exactly what it is given. Nothing accumulates in the browser,
 * because searching and sorting a pool of loaded rows answers about the pool
 * rather than about the account, and a table that quietly narrows its own
 * question is worse than one that cannot answer.
 *
 * Three rules live here rather than in three dialogs:
 *
 *   generation   A response only lands if it belongs to the newest request.
 *                Reopening a dialog, typing another letter and clicking a header
 *                all supersede whatever is in flight, and a late reply that
 *                overwrites the current page is the bug this prevents.
 *   hasMore      A failed page leaves it alone. Clearing it reads as the end of
 *                the table, which is the one thing a page must never claim
 *                wrongly.
 *   page reset   Changing the search, the sort column or its direction returns
 *                to page 1 — page 7 of a different question is not a page.
 */
export interface TablePageRequest<Sort extends string> {
  page: number
  limit: number
  q: string
  sort: Sort
  dir: 'asc' | 'desc'
}

export interface TablePageResult<Row> {
  rows: Row[]
  hasMore: boolean
  total?: number
}

export function useTablePage<Row, Sort extends string>(options: {
  /** Asks the server for one page. Throws to report a failure. */
  load: (request: TablePageRequest<Sort>) => Promise<TablePageResult<Row>>
  pageSize?: number
  sort: Sort
  /** Starting direction, and the one a column reverts to when it is first picked. */
  dir?: 'asc' | 'desc'
  /** Columns that read newest-first: picking one starts at `desc`. */
  descendingFirst?: readonly Sort[]
}) {
  const pageSize = options.pageSize ?? 100

  const page = ref(1)
  const q = ref('')
  const sort = ref(options.sort) as Ref<Sort>
  const dir = ref<'asc' | 'desc'>(options.dir ?? 'asc')

  const rows = ref([]) as Ref<Row[]>
  const total = ref<number>()
  const hasMore = ref(false)
  const loading = ref(true)
  const failed = ref(false)
  /** Set when the server refused the whole table rather than this page. */
  const unavailable = ref<string>()

  let generation = 0

  async function fetchPage() {
    const mine = ++generation
    loading.value = true
    failed.value = false

    try {
      const result = await options.load({
        page: page.value,
        limit: pageSize,
        q: q.value.trim(),
        sort: sort.value,
        dir: dir.value,
      })

      if (mine !== generation) return

      rows.value = result.rows
      total.value = result.total
      hasMore.value = result.hasMore
      unavailable.value = undefined
    }
    catch (error: any) {
      if (mine !== generation) return
      console.error('[table] could not load page:', error)
      // A 501 is the connection saying it cannot read this at all — a missing
      // database URL, not a transient fault. Worth its own words, because
      // "try again" is not the fix.
      if (error?.statusCode === 501) unavailable.value = error?.data?.message || error?.statusMessage
      else failed.value = true
      // `hasMore` is deliberately untouched.
    }
    finally {
      if (mine === generation) loading.value = false
    }
  }

  /** Start over: page 1, empty search, the starting sort. Call this on open. */
  function reset() {
    page.value = 1
    q.value = ''
    sort.value = options.sort
    dir.value = options.dir ?? 'asc'
    rows.value = []
    total.value = undefined
    hasMore.value = false
    failed.value = false
    unavailable.value = undefined
    void fetchPage()
  }

  function toggleSort(key: Sort) {
    if (sort.value === key) {
      dir.value = dir.value === 'asc' ? 'desc' : 'asc'
      return
    }
    sort.value = key
    dir.value = options.descendingFirst?.includes(key) ? 'desc' : 'asc'
  }

  function ariaSort(key: Sort) {
    if (sort.value !== key) return 'none'
    return dir.value === 'asc' ? 'ascending' : 'descending'
  }

  // Typing is debounced; a column click is not — one is a stream of intermediate
  // states and the other is a decision.
  watchDebounced(q, () => {
    page.value = 1
    void fetchPage()
  }, { debounce: 300 })

  watch([sort, dir], () => {
    page.value = 1
    void fetchPage()
  })

  watch(page, () => void fetchPage())

  return { page, q, sort, dir, rows, total, hasMore, loading, failed, unavailable, pageSize, reset, toggleSort, ariaSort, fetchPage }
}
