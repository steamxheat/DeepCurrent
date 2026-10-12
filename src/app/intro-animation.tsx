export function IntroAnimation() {
  return (
    <div className="intro-animation" aria-hidden="true">
      <svg className="intro-current" viewBox="0 0 640 120" role="presentation">
        <path
          className="intro-wave intro-wave-left"
          pathLength="1"
          d="M12 60C92 20 152 96 228 60C264 43 286 48 320 60"
        />
        <path
          className="intro-wave intro-wave-right"
          pathLength="1"
          d="M628 60C548 100 488 24 412 60C376 77 354 72 320 60"
        />
      </svg>
      <div className="intro-wordmark">Deep Current</div>
    </div>
  );
}
