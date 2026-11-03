import { notFound } from "next/navigation";
import { viewFromSlug } from "@/lib/app-views";

/** `/app/<view>`: the shell in the layout renders the view; unknown views are a real 404. */
export default async function ViewRoute({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  if (!viewFromSlug(view) || view === "overview") notFound();
  return null;
}
