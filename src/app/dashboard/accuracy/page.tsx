import { requireUser } from "@/lib/auth";
import AccuracyReport from "@/components/dashboard/AccuracyReport";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fill accuracy" };

export default async function AccuracyPage() {
  // Gated like every other dashboard page. The report itself loads client-side
  // so the portal filter can change without a round trip through the server.
  await requireUser();
  return <AccuracyReport />;
}
