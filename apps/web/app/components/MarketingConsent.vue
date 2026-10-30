<script setup lang="ts">
// The marketing opt-in on every form that creates an account, hosted offering
// only — like LegalLinks, a self-hosted deployment shows nothing, and the
// server ignores the field there anyway. Never required; the initial state is
// the caller's (signup.vue starts it ticked, the invitation form unticked).
// Ticked at submit puts the contact on the marketing list in the CRM;
// everyone gets product email regardless. The label is what the consent
// covers, so change it only together with what that list is used for.
const consent = defineModel<boolean>({ default: false })
const hosted = useHosted()
</script>

<template>
  <div v-if="hosted" class="flex items-start gap-2">
    <Checkbox
      id="marketing-consent"
      :model-value="consent"
      @update:model-value="value => consent = value === true"
    />
    <Label for="marketing-consent" class="text-sm font-normal leading-snug text-muted-foreground">
      Send me product news and tips by email. You can unsubscribe at any time.
    </Label>
  </div>
</template>
