// Markdown for agent output. Agent text is untrusted, so this builds HTML from escaped
// pieces only: nothing the text contains can become a tag or an attribute. Written as a
// plain script because gui.ts inlines it into the page; the tests load it with require.
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function renderInline(text) {
  // code spans first: nothing inside them is markdown
  return String(text)
    .split(/(`[^`\n]+`)/g)
    .map(function (part, i) {
      if (i % 2 === 1) return "<code>" + escapeHtml(part.slice(1, -1)) + "</code>";
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    })
    .join("");
}

function tableRow(line, cell) {
  var cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return "<tr>" + cells.map(function (c) { return "<" + cell + ">" + renderInline(c.trim()) + "</" + cell + ">"; }).join("") + "</tr>";
}

function isTableRule(line) {
  return !!line && line.indexOf("-") >= 0 && /^\s*\|?[\s:|-]+\|?\s*$/.test(line);
}

// the patterns that begin a block, so a paragraph knows where to stop
var LIST = /^\s*([-*]|\d+\.)\s+/;
var BLOCK = /^(```|#{1,3} |>\s?|\s*([-*]|\d+\.)\s+)/;

function renderMarkdown(src) {
  if (!src) return "";
  var lines = String(src).replace(/\r\n/g, "\n").split("\n");
  var html = "";
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (/^```/.test(line)) {
      var code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      html += "<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>";
    } else if (/^#{1,3} /.test(line)) {
      var level = /^#+/.exec(line)[0].length + 1;
      html += "<h" + level + ">" + renderInline(line.slice(level)) + "</h" + level + ">";
      i++;
    } else if (line.indexOf("|") >= 0 && isTableRule(lines[i + 1])) {
      var table = "<thead>" + tableRow(line, "th") + "</thead><tbody>";
      for (i += 2; i < lines.length && lines[i].indexOf("|") >= 0; i++) table += tableRow(lines[i], "td");
      html += "<table>" + table + "</tbody></table>";
    } else if (LIST.test(line)) {
      var ordered = /^\s*\d+\./.test(line);
      var items = "";
      for (; i < lines.length && LIST.test(lines[i]) && /^\s*\d+\./.test(lines[i]) === ordered; i++) {
        items += "<li>" + renderInline(lines[i].replace(LIST, "")) + "</li>";
      }
      html += (ordered ? "<ol>" : "<ul>") + items + (ordered ? "</ol>" : "</ul>");
    } else if (/^>\s?/.test(line)) {
      var quote = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(renderInline(lines[i].replace(/^>\s?/, "")));
      html += "<blockquote>" + quote.join("<br>") + "</blockquote>";
    } else if (!line.trim()) {
      i++;
    } else {
      var para = [];
      for (; i < lines.length && lines[i].trim() && !BLOCK.test(lines[i]) && !(lines[i].indexOf("|") >= 0 && isTableRule(lines[i + 1])); i++) para.push(renderInline(lines[i]));
      html += "<p>" + para.join("<br>") + "</p>";
    }
  }
  return html;
}

if (typeof module !== "undefined") module.exports = { escapeHtml, renderMarkdown };
