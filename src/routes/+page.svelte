<script lang="ts">
  // Phase 1 dashboard placeholder. Either prompts the user to sign in
  // (AUTH-01 happy path) or shows a "your dashboard is empty" stub for
  // returning users (AUTH-02 sign-out hook lives on the same page).
  // Phase 2 lands real game cards in this slot.
  import { signIn, signOut } from '$lib/auth-client';
  let { data } = $props();
</script>

{#if data.user}
  <h1>Promotion diary</h1>
  <p>Hello {data.user.name}. Your dashboard is empty — Phase 2 lands games.</p>
  <button onclick={() => signOut()}>Sign out</button>
{:else}
  <h1>Promotion diary</h1>
  <p>Sign in with Google to begin.</p>
  <button
    onclick={() => signIn.social({ provider: 'google', callbackURL: '/' })}
  >
    Sign in with Google
  </button>
{/if}
