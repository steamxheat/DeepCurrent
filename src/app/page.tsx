import { Dashboard } from "./dashboard";
import { getDashboardData } from "@/lib/hyperliquid";
import { connection } from "next/server";
import { Suspense } from "react";

export default function Home() {
  return <Suspense fallback={<DashboardSkeleton/>}><LiveDashboard/></Suspense>;
}

async function LiveDashboard() {
  await connection();
  const data = await getDashboardData();
  return <Dashboard initialData={data} />;
}

function DashboardSkeleton() {
  return <main className="mx-auto min-h-dvh w-full max-w-[1500px] animate-pulse px-3 py-5 sm:px-5"><div className="mb-5 h-10 w-72 rounded-md bg-white/[.05]"/><div className="h-14 rounded-lg border border-[var(--line)] bg-white/[.025]"/><div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"><div className="h-[620px] rounded-lg border border-[var(--line)] bg-white/[.025]"/><div className="hidden space-y-4 xl:block"><div className="h-64 rounded-lg border border-[var(--line)] bg-white/[.025]"/><div className="h-80 rounded-lg border border-[var(--line)] bg-white/[.025]"/></div></div></main>;
}
