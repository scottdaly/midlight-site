import React from 'react';
import { Link } from 'react-router-dom';
import Footer from '../components/Footer';

const AppleIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
  </svg>
);

const WindowsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 12V6.75l6-1.32v6.48L3 12zm17-9v8.75l-10 .15V5.21L20 3zM3 13l6 .09v6.81l-6-1.15V13zm17 .25V22l-10-1.91V13.1l10 .15z"/>
  </svg>
);

const CursorIcon = () => (
  <svg width="30px" height="30px" viewBox="0 0 1188 1186" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g filter="url(#filter0_i_download)">
      <rect width="1188" height="1185.94" rx="55.6875" fill="url(#paint0_linear_download)"/>
    </g>
    <g filter="url(#filter1_dii_download)">
      <path d="M635.043 331.497C635.983 333.431 638.282 334.276 640.25 333.411L794.69 265.537C796.647 264.677 798.934 265.508 799.883 267.424L833.973 336.253C834.033 336.373 834.206 336.368 834.257 336.245C834.273 336.208 834.301 336.178 834.338 336.162L987.043 268.077C990.342 266.606 993.747 269.916 992.369 273.256L906.263 481.997C906.232 482.071 906.235 482.154 906.271 482.226L906.323 482.331C906.39 482.466 906.292 482.625 906.141 482.625C906.059 482.625 905.984 482.675 905.953 482.751L724.958 921.525C724.341 923.023 722.881 924 721.261 924H593.827C590.969 924 589.033 921.089 590.138 918.453L771.921 484.912C772.527 483.464 772.232 481.796 771.165 480.645L732.266 438.689C730.282 436.549 726.748 437.185 725.635 439.883L708.265 481.992C708.234 482.066 708.237 482.15 708.272 482.222L708.325 482.331C708.392 482.467 708.293 482.625 708.142 482.625C708.059 482.625 707.984 482.675 707.953 482.751L526.958 921.525C526.341 923.023 524.881 924 523.261 924H395.823C392.966 924 391.03 921.091 392.133 918.456L573.901 484.188C574.349 483.117 574.31 481.905 573.794 480.865L543.268 419.381C541.74 416.303 537.298 416.458 535.988 419.634L328.958 921.525C328.341 923.023 326.881 924 325.261 924H197.789C194.941 924 193.006 921.108 194.092 918.475L463.042 266.475C463.659 264.977 465.119 264 466.739 264H599.746C601.278 264 602.675 264.874 603.344 266.252L635.043 331.497Z" fill="#D9D9D9"/>
    </g>
    <defs>
      <filter id="filter0_i_download" x="0" y="0" width="1190" height="1189.94" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feFlood floodOpacity="0" result="BackgroundImageFix"/>
        <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
        <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
        <feOffset dx="2" dy="8"/>
        <feGaussianBlur stdDeviation="2"/>
        <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
        <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.25 0"/>
        <feBlend mode="normal" in2="shape" result="effect1_innerShadow_download"/>
      </filter>
      <filter id="filter1_dii_download" x="189.785" y="260" width="814.898" height="676" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feFlood floodOpacity="0" result="BackgroundImageFix"/>
        <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
        <feOffset dx="4" dy="4"/>
        <feGaussianBlur stdDeviation="4"/>
        <feComposite in2="hardAlpha" operator="out"/>
        <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0"/>
        <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_download"/>
        <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_download" result="shape"/>
        <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
        <feOffset dx="-4" dy="-4"/>
        <feGaussianBlur stdDeviation="2"/>
        <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
        <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>
        <feBlend mode="normal" in2="shape" result="effect2_innerShadow_download"/>
        <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
        <feOffset dx="4" dy="4"/>
        <feGaussianBlur stdDeviation="2"/>
        <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
        <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.8 0"/>
        <feBlend mode="normal" in2="effect2_innerShadow_download" result="effect3_innerShadow_download"/>
      </filter>
      <linearGradient id="paint0_linear_download" x1="239" y1="-2.1796e-05" x2="1067.5" y2="1186" gradientUnits="userSpaceOnUse">
        <stop stopColor="#333333"/>
        <stop offset="1" stopColor="#1F1F1F"/>
      </linearGradient>
    </defs>
  </svg>
);

function Download() {
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

      {/* Download Hero */}
      <section className="download-hero">
        <div className="container">
          <h1>Download Midlight</h1>
          <p className="download-subtitle">
            Choose your platform and start writing distraction-free.
          </p>

          <div className="download-cards">
            {/* macOS Card */}
            <div className="download-card">
              <div className="platform-icon">
                <AppleIcon />
              </div>
              <h2>macOS</h2>
              <p className="version">Version 0.0.1</p>
              <button className="btn-primary download-btn">
                Download for Mac
              </button>
              <div className="system-requirements">
                <h4>System Requirements</h4>
                <ul>
                  <li>macOS 12.0 (Monterey) or later</li>
                  <li>Apple Silicon or Intel processor</li>
                  <li>4 GB RAM minimum</li>
                  <li>200 MB available storage</li>
                </ul>
              </div>
            </div>

            {/* Windows Card */}
            <div className="download-card">
              <div className="platform-icon">
                <WindowsIcon />
              </div>
              <h2>Windows</h2>
              <p className="version">Version 0.0.1</p>
              <button className="btn-primary download-btn">
                Download for Windows
              </button>
              <div className="system-requirements">
                <h4>System Requirements</h4>
                <ul>
                  <li>Windows 10 (64-bit) or later</li>
                  <li>x64 processor</li>
                  <li>4 GB RAM minimum</li>
                  <li>200 MB available storage</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

export default Download;
