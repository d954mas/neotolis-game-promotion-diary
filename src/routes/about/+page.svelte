<script lang="ts">
  // /about — alias for the canonical landing on `/`. Renders the same
  // <AboutContent> component the root path renders for anonymous users.
  // Kept as a separate route so:
  //   - Nav About tab (signed-in users) has somewhere to navigate to
  //     (root would redirect them to /feed)
  //   - /privacy and /terms back-links keep working
  //   - Old bookmarks of /about stay live
  // <link rel="canonical"> in AboutContent points to `/`, telling search
  // engines to treat /about as a duplicate of /.
  import AboutContent from "$lib/components/AboutContent.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<AboutContent {data} />
