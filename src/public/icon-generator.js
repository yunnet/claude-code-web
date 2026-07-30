// Simple icon generator for PWA
// This creates basic SVG icons with the Claude Code logo

function generateIcon(size) {
    // Green Claude-robot icon (matches the /icon-*.png route in server.js).
    const svg = `
        <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <rect width="24" height="24" rx="5" fill="#2ea043"/>
            <g fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="2.5" x2="12" y2="5"/>
                <rect x="4" y="5" width="16" height="15" rx="4"/>
                <path d="M9 11h.01M15 11h.01"/>
                <path d="M9 16c1.2 .9 2.4 .9 3.6 0"/>
            </g>
        </svg>
    `;
    return 'data:image/svg+xml;base64,' + btoa(svg);
}

// Export for use in server
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generateIcon };
}