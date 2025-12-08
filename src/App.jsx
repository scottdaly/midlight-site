import React from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { ThemeProvider } from './ThemeContext';
import Download from './pages/Download';
import Footer from './components/Footer';

// Simple Icon Components (SVG)
const CursorIcon = () => (
  <svg width="30px" height="30px" viewBox="0 0 1188 1186" fill="none" xmlns="http://www.w3.org/2000/svg">
<g filter="url(#filter0_i_17_2)">
<rect width="1188" height="1185.94" rx="55.6875" fill="url(#paint0_linear_17_2)"/>
</g>
<g filter="url(#filter1_dii_17_2)">
<path d="M635.043 331.497C635.983 333.431 638.282 334.276 640.25 333.411L794.69 265.537C796.647 264.677 798.934 265.508 799.883 267.424L833.973 336.253C834.033 336.373 834.206 336.368 834.257 336.245C834.273 336.208 834.301 336.178 834.338 336.162L987.043 268.077C990.342 266.606 993.747 269.916 992.369 273.256L906.263 481.997C906.232 482.071 906.235 482.154 906.271 482.226L906.323 482.331C906.39 482.466 906.292 482.625 906.141 482.625C906.059 482.625 905.984 482.675 905.953 482.751L724.958 921.525C724.341 923.023 722.881 924 721.261 924H593.827C590.969 924 589.033 921.089 590.138 918.453L771.921 484.912C772.527 483.464 772.232 481.796 771.165 480.645L732.266 438.689C730.282 436.549 726.748 437.185 725.635 439.883L708.265 481.992C708.234 482.066 708.237 482.15 708.272 482.222L708.325 482.331C708.392 482.467 708.293 482.625 708.142 482.625C708.059 482.625 707.984 482.675 707.953 482.751L526.958 921.525C526.341 923.023 524.881 924 523.261 924H395.823C392.966 924 391.03 921.091 392.133 918.456L573.901 484.188C574.349 483.117 574.31 481.905 573.794 480.865L543.268 419.381C541.74 416.303 537.298 416.458 535.988 419.634L328.958 921.525C328.341 923.023 326.881 924 325.261 924H197.789C194.941 924 193.006 921.108 194.092 918.475L463.042 266.475C463.659 264.977 465.119 264 466.739 264H599.746C601.278 264 602.675 264.874 603.344 266.252L635.043 331.497Z" fill="#D9D9D9"/>
</g>
<defs>
<filter id="filter0_i_17_2" x="0" y="0" width="1190" height="1189.94" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
<feFlood floodOpacity="0" result="BackgroundImageFix"/>
<feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
<feOffset dx="2" dy="8"/>
<feGaussianBlur stdDeviation="2"/>
<feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
<feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.25 0"/>
<feBlend mode="normal" in2="shape" result="effect1_innerShadow_17_2"/>
</filter>
<filter id="filter1_dii_17_2" x="189.785" y="260" width="814.898" height="676" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
<feFlood floodOpacity="0" result="BackgroundImageFix"/>
<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
<feOffset dx="4" dy="4"/>
<feGaussianBlur stdDeviation="4"/>
<feComposite in2="hardAlpha" operator="out"/>
<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0"/>
<feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_17_2"/>
<feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_17_2" result="shape"/>
<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
<feOffset dx="-4" dy="-4"/>
<feGaussianBlur stdDeviation="2"/>
<feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>
<feBlend mode="normal" in2="shape" result="effect2_innerShadow_17_2"/>
<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
<feOffset dx="4" dy="4"/>
<feGaussianBlur stdDeviation="2"/>
<feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
<feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.8 0"/>
<feBlend mode="normal" in2="effect2_innerShadow_17_2" result="effect3_innerShadow_17_2"/>
</filter>
<linearGradient id="paint0_linear_17_2" x1="239" y1="-2.1796e-05" x2="1067.5" y2="1186" gradientUnits="userSpaceOnUse">
<stop stopColor="#333333"/>
<stop offset="1" stopColor="#1F1F1F"/>
</linearGradient>
</defs>
</svg>
);

const SparkleIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <line x1="2" x2="22" y1="2" y2="22" />
  </svg>
);

const RefreshIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </svg>
);

function Home() {
  return (
    <div className="app">
      {/* Navigation */}
      <div className="container">
        <nav>
          <Link to="/" className="logo">
            <CursorIcon /> Midlight
          </Link>
        </nav>
      </div>

      {/* Hero Section */}
      <section className="hero">
        <div className="container">
          <div className="hero-visual">
            <img src="/Midlight-shot.png" alt="Midlight app screenshot" className="hero-image" />
          </div>

          <div className="hero-text">
            <h1>Writing,<br />reimagined.</h1>
            <p style={{ marginTop: '1.5rem', marginBottom: '2.5rem', maxWidth: '500px', marginInline: 'auto' }}>
              Midlight is the intelligent, distraction-free environment built for the modern writer. Experience the flow state.
            </p>
            <Link to="/download" className="btn-primary">Download for Mac & Windows</Link>
          </div>

          {/* Features Grid */}
          <div className="features-grid">
            <div className="feature-item">
              <div className="icon-box"><SparkleIcon /></div>
              <h3>AI-Powered Muse</h3>
              <p>Intelligent suggestions that adapt to your tone, helping you break through writer's block instantly.</p>
            </div>
            <div className="feature-item">
              <div className="icon-box"><EyeOffIcon /></div>
              <h3>Distraction-Free Zen</h3>
              <p>A UI that fades away when you type. Focus purely on your words with our deep-focus Zen Mode.</p>
            </div>
            <div className="feature-item">
              <div className="icon-box"><RefreshIcon /></div>
              <h3>Seamless Sync</h3>
              <p>Start on your desktop, finish on your tablet. Your drafts are synced instantly across all devices.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Showcase Section */}
      <section className="showcase">
        <div className="container showcase-content">
          <div className="laptop-mockup">
            <div className="mockup-screen">
              <div className="mockup-dots">
                <div className="mockup-dot red"></div>
                <div className="mockup-dot yellow"></div>
                <div className="mockup-dot green"></div>
              </div>
              <h3 className="mockup-title">The Art of Focus</h3>
              <div className="mockup-line" style={{width: '90%'}}></div>
              <div className="mockup-line" style={{width: '95%'}}></div>
              <div className="mockup-line" style={{width: '85%'}}></div>
              <div className="mockup-line" style={{width: '92%'}}></div>
            </div>
          </div>

          <div className="showcase-text">
            <h2>The Art of Focus</h2>
            <p style={{ marginBottom: '1.5rem' }}>
              Midlight removes the clutter of traditional word processors. No ribbons, no rulers, no unnecessary buttons. Just you and the cursor.
            </p>
            <ul style={{ listStyle: 'none', color: 'var(--text-muted)', lineHeight: '2' }}>
               <li>✓ Markdown Support</li>
               <li>✓ Typewriter Scrolling</li>
               <li>✓ Custom Themes</li>
            </ul>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/download" element={<Download />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
