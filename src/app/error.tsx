"use client";

export default function ErrorPage({ reset }: { reset(): void }) {
  return <main className="flex min-h-dvh items-center justify-center px-6"><div className="glass max-w-md rounded-[24px] p-7 text-center"><p className="text-lg font-semibold">Данные временно не загрузились</p><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Hyperliquid мог ограничить запрос или ненадолго отключиться. Попробуй ещё раз.</p><button onClick={reset} className="mt-5 min-h-11 rounded-xl bg-[var(--cyan)] px-5 font-semibold text-[#051014] transition-opacity hover:opacity-90">Повторить</button></div></main>;
}
