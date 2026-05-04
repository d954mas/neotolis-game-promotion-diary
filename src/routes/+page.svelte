<!--
  Root `/` never renders — `+page.server.ts` always redirects:
    - Authenticated → /feed
    - Anonymous → /about
  This file exists only so SvelteKit recognises the route. The body is
  intentionally empty.
-->
