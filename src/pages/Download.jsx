import React, { useState, useEffect } from 'react';
import Header from '../components/Header';
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

function Download() {
  const [versionInfo, setVersionInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('https://midlight.ai/releases/version.json')
      .then(res => res.json())
      .then(data => {
        setVersionInfo(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to fetch version info:', err);
        setLoading(false);
      });
  }, []);

  const version = versionInfo?.version || '0.0.5';
  const macDownload = versionInfo?.downloads?.mac?.dmg || `https://midlight.ai/releases/Midlight-${version}-arm64.dmg`;
  const winDownload = versionInfo?.downloads?.windows?.exe ||
`https://midlight.ai/releases/Midlight%20Setup%20${version}.exe`;

  return (
    <div className="app">
      <Header />

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
              <p className="version">Version {loading ? '...' : version}</p>
              <a
                href={macDownload}
                className="btn-primary download-btn"
              >
                Download for Mac
              </a>
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
              <p className="version">Version {loading ? '...' : version}</p>
              <a
                href={winDownload}
                className="btn-primary download-btn"
              >
                Download for Windows
              </a>
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