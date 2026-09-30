import { ErrorPage, page, type PageContext } from "../views/layout";

export function errorResponse(
  context: PageContext | null,
  status: number,
  title: string,
  message: string,
  code?: string,
): Response {
  return page(<ErrorPage context={context} title={title} message={message} code={code} />, status);
}

export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
