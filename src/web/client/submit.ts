// Posts a form without leaving the page. The server answers a form with a
// page, as it would for a browser, so the answer is that page: either the one
// the post led to, or an error page whose message says why it was refused.

export type Answer = { kind: "accepted"; page: Document; path: string } | { kind: "refused"; message: string };

type View = Window & typeof globalThis;

const UNREACHABLE = "Commonplace couldn't be reached. Check your connection, and try again.";

function pageOf(view: View, html: string): Document {
  return new view.DOMParser().parseFromString(html, "text/html");
}

async function answerOf(view: View, request: Promise<Response>): Promise<Answer> {
  let response: Response;
  let html: string;
  try {
    response = await request;
    html = await response.text();
  } catch {
    return { kind: "refused", message: UNREACHABLE };
  }
  const page = pageOf(view, html);
  if (response.ok) return { kind: "accepted", page, path: new URL(response.url).pathname };
  return { kind: "refused", message: page.querySelector("#error-message")?.textContent ?? UNREACHABLE };
}

export function submitInPlace(view: View, action: string, fields: URLSearchParams): Promise<Answer> {
  return answerOf(view, view.fetch(action, { method: "POST", body: fields }));
}

export function fetchPage(view: View, address: string): Promise<Answer> {
  return answerOf(view, view.fetch(address));
}
