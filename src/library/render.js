const jsonText = (value) =>
  JSON.stringify(value).replace(
    /[<>&]/g,
    (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char],
  );
const escapeHTML = (value) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );

export function workspaceDocument(
  shell,
  runtime,
  entry,
  hostFilename = '',
  css = '',
) {
  const frameAttributes = Object.entries({
    'data-workbench-id': entry.id,
    'data-initial-server': entry.server || '',
    'data-initial-server-profile': entry.serverProfile || '',
  })
    .map(([key, value]) => key + '="' + escapeHTML(value) + '"')
    .join(' ');
  const values = {
    WORKFLOW_JSON: jsonText(entry.graph),
    PROFILE_JSON: jsonText(entry.profile),
    WORKFLOW_TITLE: escapeHTML(entry.title),
    OUTPUT_FILENAME: encodeURIComponent(hostFilename || 'Frameform.html'),
    WORKBENCH_HEADING: entry.video ? '视频生成工作台' : '图像生成工作台',
    WORKBENCH_OVERLINE: 'COMFYUI WORKSPACE',
    WORKBENCH_PLACEHOLDER: '输入生成提示词…',
    WORKBENCH_FOOTER: 'FRAMEFORM / COMFYUI',
    APP_JS: runtime,
  };
  // Replace in one pass so embedded content is never reinterpreted as a marker.
  const document = shell
    .replace(
      '<html lang="zh-CN">',
      '<html lang="zh-CN" ' + frameAttributes + '>',
    )
    .replace('<body>', '<body class="workbench-embedded">')
    .replace('</head>', () => '<style>' + css + '</style></head>');
  return document.replace(
    /WORKFLOW_JSON|PROFILE_JSON|WORKFLOW_TITLE|OUTPUT_FILENAME|WORKBENCH_HEADING|WORKBENCH_OVERLINE|WORKBENCH_PLACEHOLDER|WORKBENCH_FOOTER|APP_JS/g,
    (token) => values[token],
  );
}
