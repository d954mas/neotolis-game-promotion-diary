<script lang="ts">
  // Explicit /login route used as a redirect target by Plan 07's tenantScope
  // when an unauthenticated browser request hits a protected page. Plan 07
  // wires the redirect; this page just renders the Google sign-in button.
  import { signIn } from '$lib/auth-client';
</script>

<h1>Sign in</h1>
<button
  onclick={() => signIn.social({ provider: 'google', callbackURL: '/' })}
>
  Continue with Google
</button>
