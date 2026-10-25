import fs from 'node:fs';

// Fictional content rendered through the actual CV stylesheet. Geometry and
// native paint order, rather than candidate facts, are the regression subject.
export const decoratedSummary = 'Hands-on, thoughtful engineering leader building reliable products with small teams. ' +
  'Coordinates product planning and delivery across web and mobile services, coaches engineers, and supports clear technical decisions. ' +
  'Uses practical feedback, structured interviews, and continuous learning to improve teamwork. ' +
  'Stays close to architecture and code in TypeScript, React and Node.js, and works with product partners to turn user needs into maintainable software. ' +
  'Values written communication, calm collaboration, and dependable delivery.';
export const competencyLabels = [
  'Reliable Product Delivery', 'Practical Team Coaching', 'Structured Interviews',
  'Technical Decision Making', 'Thoughtful Engineering', 'Continuous Learning',
  'Written Team Communication', 'TypeScript, React & Node.js',
];
export const bulletLabels = [
  'Built reliable services with the product team and documented the operating practices.',
  'Improved delivery habits through clear priorities and regular engineering feedback.',
  'Supported team learning with useful examples and careful technical reviews.',
  'Coordinated planning across product and engineering for a fictional service.',
];

export function decoratedCvHtml() {
  const template = fs.readFileSync(new URL('../../../templates/cv-template.html', import.meta.url), 'utf8');
  const job = (name, period, continued = false) => `<div class="job${continued ? ' fictional-page-break' : ''}">
    <div class="job-header"><span class="job-company">${name}</span><span class="job-period">${period}</span></div>
    <div class="job-role">Engineering Lead <span class="job-location">| Fictional City</span></div>
    <p class="job-context">Led engineering across web and mobile products, working with <strong>design teams</strong> to improve delivery and build reliable services.</p>
    <ul>${bulletLabels.map(text => `<li>${text}</li>`).join('')}</ul></div>`;
  const body = `<div class="page">
    <div class="header"><h1>Fictional Candidate</h1><div class="header-title">Engineering Leader</div><div class="header-gradient"></div>
      <div class="contact-row"><a href="mailto:candidate@example.test">candidate@example.test</a><a href="https://example.test/profile">example.test/profile</a><span>Fictional City</span></div></div>
    <div class="section"><div class="section-title">Professional Summary</div><div class="summary-text">${decoratedSummary.replace('engineering leader', '<strong>engineering leader</strong>').replace('TypeScript, React and Node.js', '<strong>TypeScript, React and Node.js</strong>')}</div></div>
    <div class="section"><div class="section-title">Core Competencies</div><div class="competencies-grid">${competencyLabels.map(label => `<span class="competency-tag">${label}</span>`).join('')}</div></div>
    <div class="section"><div class="section-title">Work Experience</div>
      ${job('Fixture Alpha', '2024 - Present')}${job('Fixture Beta', '2021 - 2024', true)}${job('Fixture Gamma', '2018 - 2021')}</div>
    <div class="section fictional-page-break"><div class="section-title">Education</div><p>Fictional education entry for a browser test.</p></div>
    <div class="section"><div class="section-title">Skills</div><p>TypeScript, React, Node.js, written communication, technical reviews.</p></div>
  </div>`;
  return template.replace(/\{\{LANG\}\}/g, 'en').replace(/\{\{PAGE_WIDTH\}\}/g, '210mm')
    .replace('</style>', '@page{size:A4;margin:43.5pt}.fictional-page-break{break-before:page}</style>')
    .replace(/<body>[\s\S]*<\/body>/, `<body>${body}</body>`);
}
