import { ACTION } from "./controls";
import { Layout } from "./layout";
import { Sheet } from "./sheet";

// Signing out lands here rather than on a page that requires a session,
// which would send the reader through the identity provider and sign them
// straight back in.
export function SignedOutPage() {
  return (
    <Layout title="Signed out" context={null}>
      <Sheet labelledBy="signed-out-title">
        <h1 id="signed-out-title" class="sheet-title">You’ve signed out</h1>
        <p class="sheet-lede">Your library is kept as you left it. Sign in to open it again.</p>
        <p class="sheet-actions">
          <a class={ACTION} href="/login">Sign in</a>
        </p>
      </Sheet>
    </Layout>
  );
}
