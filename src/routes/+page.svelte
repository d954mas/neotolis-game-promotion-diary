<script lang="ts">
  // Root `/` — anonymous canonical landing. Signed-in users never reach
  // this component because `+page.server.ts` redirects them to `/feed`
  // before the load returns. Anonymous users see the same marketing
  // content as `/about` (rendered via the shared <AboutContent> component);
  // <link rel="canonical"> on both pages points to `/` so Google indexes
  // root as the canonical URL.
  import AboutContent from "$lib/components/AboutContent.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<AboutContent {data} />
