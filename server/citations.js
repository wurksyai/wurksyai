export function citeHarvard({
  author = "",
  year = "",
  title = "",
  journal = "",
  volume = "",
  issue = "",
  pages = "",
  doi = "",
}) {
  const a = author || "";
  const y = year ? ` (${year})` : "";
  const t = title ? ` ${title}.` : "";
  const j = journal ? ` ${journal}` : "";
  const vi = volume ? `, ${volume}` : "";
  const is = issue ? `(${issue})` : "";
  const pg = pages ? `, pp. ${pages}` : "";
  const d = doi
    ? `. https://doi.org/${doi.replace(/^https?:\/\/doi\.org\//i, "")}`
    : "";
  return `${a}${y}.${t}${j}${vi}${is}${pg}${d}`;
}

export function citeVancouver({
  author = "",
  title = "",
  journal = "",
  year = "",
  volume = "",
  issue = "",
  pages = "",
  doi = "",
}) {
  const a = author ? `${author}. ` : "";
  const t = title ? `${title}. ` : "";
  const j = journal ? `${journal}. ` : "";
  const y = year ? `${year};` : "";
  const vi = volume ? `${volume}` : "";
  const is = issue ? `(${issue})` : "";
  const pg = pages ? `:${pages}` : "";
  const d = doi ? `. doi:${doi.replace(/^https?:\/\/doi\.org\//i, "")}` : "";
  return `${a}${t}${j}${y}${vi}${is}${pg}${d}`.replace(/\s+/g, " ").trim();
}

