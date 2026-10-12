import Image from "next/image";

export function IntroAnimation() {
  return (
    <div className="intro-animation is-running" aria-hidden="true">
      <video className="intro-video" autoPlay muted playsInline preload="auto">
        <source src="/deep-current-intro.mp4" type="video/mp4" />
      </video>
      <div className="intro-reduced">
        <Image src="/dc-pulse-mark.png" alt="" width={180} height={180} priority />
        <span>Deep Current</span>
      </div>
    </div>
  );
}
