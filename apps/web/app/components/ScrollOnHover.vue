<script setup lang="ts">
import { usePreferredReducedMotion } from '@vueuse/core'

/**
 * One line of text that truncates at rest and slides to its end on hover.
 *
 * The overflow is measured on mouseenter rather than done in pure CSS: a
 * `translateX(calc(100cqw - 100%))` lands on the right endpoint, but it cannot
 * make the duration follow the distance (a long host would race past, a short
 * one crawl), and it cannot leave a string that already fits standing still.
 */
defineProps<{ text: string }>()

/** Scroll speed, px/s. */
const SPEED = 40
/** Pause before scrolling, so a cursor passing over the text does not jolt it. */
const DELAY_MS = 300

const reducedMotion = usePreferredReducedMotion()
const inner = ref<HTMLElement>()
const distance = ref(0)

function start() {
  const el = inner.value
  if (!el) return
  // Measured while still truncated: scrollWidth is the full string, clientWidth the visible part.
  distance.value = Math.max(0, el.scrollWidth - el.clientWidth)
}

function stop() {
  distance.value = 0
}

const style = computed(() => {
  // Reduced motion: jump to the end rather than animate.
  if (reducedMotion.value === 'reduce') {
    return distance.value > 0 ? { transform: `translateX(-${distance.value}px)` } : {}
  }
  if (distance.value <= 0) return { transition: 'transform 200ms ease-out' }
  const seconds = Math.max(1, distance.value / SPEED)
  return {
    transform: `translateX(-${distance.value}px)`,
    transition: `transform ${seconds}s linear ${DELAY_MS}ms`,
  }
})
</script>

<template>
  <span class="block overflow-hidden" :title="text" @mouseenter="start" @mouseleave="stop">
    <span
      ref="inner"
      :class="distance > 0 ? 'inline-block whitespace-nowrap' : 'block truncate'"
      :style="style"
    >{{ text }}</span>
  </span>
</template>
