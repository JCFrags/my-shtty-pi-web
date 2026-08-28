from __future__ import annotations

import html as html_module
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

try:
    import trafilatura
except ImportError:
    trafilatura = None  # type: ignore[assignment]

HtmlView = Literal["main", "outline", "raw"]
CURRENT_TRAF_ID = "trafilatura"
REVISED_TRAF_ID = "trafilatura-recall"


@dataclass(slots=True)
class HtmlExtraction:
    content: str
    title: str
    extractor: str
    metadata: dict[str, Any] = field(default_factory=dict)


class HtmlExtractor(Protocol):
    """A fetch-independent HTML extractor.

    Implementations receive no transport, browser, file, or expected-quality data.
    """

    def extract(
        self,
        html: str,
        url: str,
        view: HtmlView,
        query: str | None,
    ) -> HtmlExtraction: ...


@dataclass(frozen=True, slots=True)
class TrafilaturaExtractor:
    identity: str
    favor_precision: bool
    favor_recall: bool
    deduplicate: bool

    def extract(
        self,
        html: str,
        url: str,
        view: HtmlView,
        query: str | None,
    ) -> HtmlExtraction:
        del url  # The extractor must not fetch or resolve the URL.
        title = extract_title(html)
        if view == "raw":
            return HtmlExtraction(html, title, "raw-html", {"configuredExtractor": self.identity})
        if view == "outline":
            outline = outline_from_html(html)
            if outline:
                return HtmlExtraction(
                    outline,
                    title,
                    "html-headings",
                    {"configuredExtractor": self.identity},
                )
        if trafilatura is not None:
            extracted = trafilatura.extract(
                html,
                output_format="markdown",
                include_links=True,
                include_images=False,
                include_tables=True,
                include_comments=False,
                favor_precision=self.favor_precision,
                favor_recall=self.favor_recall,
                deduplicate=self.deduplicate,
            )
            if extracted:
                if view == "outline":
                    extracted = outline_from_markdown(extracted)
                elif query:
                    extracted = select_query_context(extracted, query)
                return HtmlExtraction(
                    extracted,
                    title,
                    self.identity,
                    {
                        "configuredExtractor": self.identity,
                        "favorPrecision": self.favor_precision,
                        "favorRecall": self.favor_recall,
                        "deduplicate": self.deduplicate,
                    },
                )
        fallback = html_to_text(html)
        if view == "outline":
            fallback = outline_from_html(html)
        elif query:
            fallback = select_query_context(fallback, query)
        return HtmlExtraction(
            fallback,
            title,
            "stdlib-fallback",
            {"configuredExtractor": self.identity},
        )


EXTRACTORS: dict[str, HtmlExtractor] = {
    CURRENT_TRAF_ID: TrafilaturaExtractor(CURRENT_TRAF_ID, True, False, True),
    REVISED_TRAF_ID: TrafilaturaExtractor(REVISED_TRAF_ID, False, True, False),
}


def extract_html(
    html: str,
    url: str,
    view: HtmlView,
    query: str | None,
    *,
    extractor_id: str = CURRENT_TRAF_ID,
) -> HtmlExtraction:
    """Run one reviewed extractor through the neutral four-input contract."""
    try:
        extractor = EXTRACTORS[extractor_id]
    except KeyError:
        raise ValueError(f"unknown HTML extractor: {extractor_id}") from None
    result = extractor.extract(html, url, view, query)
    result.metadata = {
        **result.metadata,
        "extractor": result.extractor,
        "sourceParagraphs": len(re.findall(r"(?i)<p\b", html)),
    }
    return result


def normalize_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.split("\n")]
    output: list[str] = []
    blank = False
    for line in lines:
        if not line:
            if output and not blank:
                output.append("")
            blank = True
        else:
            output.append(line)
            blank = False
    return "\n".join(output).strip()


def strip_tags(value: str) -> str:
    return re.sub(r"(?s)<[^>]+>", " ", value)


def extract_title(document: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", document, flags=re.IGNORECASE | re.DOTALL)
    return normalize_text(html_module.unescape(strip_tags(match.group(1)))) if match else ""


def html_to_text(document: str) -> str:
    cleaned = re.sub(r"(?is)<(script|style|template|svg|noscript)\b.*?</\1>", " ", document)
    cleaned = re.sub(r"(?i)</(p|div|section|article|main|li|tr|h[1-6])>", "\n", cleaned)
    cleaned = re.sub(r"(?i)<br\s*/?>", "\n", cleaned)
    return normalize_text(html_module.unescape(strip_tags(cleaned)))


def outline_from_html(document: str) -> str:
    headings = re.findall(r"(?is)<h([1-6])\b[^>]*>(.*?)</h\1>", document)
    return "\n".join(
        f"{'#' * int(level)} {normalize_text(html_module.unescape(strip_tags(body)))}"
        for level, body in headings
    )


def outline_from_markdown(markdown: str) -> str:
    return "\n".join(
        line.strip()
        for line in markdown.splitlines()
        if re.match(r"^#{1,6}\s+\S", line.strip())
    )


def select_query_context(text: str, query: str, *, radius: int = 1) -> str:
    noise = {"and", "for", "from", "into", "only", "that", "the", "this", "with"}
    terms = list(
        dict.fromkeys(
            term.casefold()
            for term in re.findall(r"[\w-]{3,}", query)
            if term.casefold() not in noise
        )
    )
    if not terms:
        return text
    heading_matches = list(re.finditer(r"(?m)^#{1,6}\s+\S.*$", text))
    if heading_matches:
        sections: list[tuple[int, int, str]] = []
        preamble = text[: heading_matches[0].start()].strip()
        if preamble:
            score = sum(
                1 for term in terms if query_term_matches(term, preamble.casefold())
            )
            if score:
                sections.append((score, -1, preamble))
        for index, match in enumerate(heading_matches):
            end = (
                heading_matches[index + 1].start()
                if index + 1 < len(heading_matches)
                else len(text)
            )
            section = text[match.start():end].strip()
            lowered = section.casefold()
            heading = match.group(0).casefold()
            score = sum(
                (4 if term in heading else 1)
                for term in terms
                if query_term_matches(term, lowered)
            )
            if score:
                sections.append((score, index, section))
        if sections:
            covered: set[str] = set()
            best: list[tuple[int, int, str]] = []
            for item in sorted(sections, key=lambda candidate: (-candidate[0], candidate[1])):
                lowered = item[2].casefold()
                matched = {
                    term for term in terms if query_term_matches(term, lowered)
                }
                if not matched - covered:
                    continue
                best.append(item)
                covered.update(matched)
                if len(best) >= 12 or len(covered) == len(terms):
                    break
            return "\n\n".join(
                section for _, _, section in sorted(best, key=lambda item: item[1])
            )
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    scored = [
        (
            sum(
                1
                for term in terms
                if query_term_matches(term, paragraph.casefold())
            ),
            index,
        )
        for index, paragraph in enumerate(paragraphs)
    ]
    matches = [(score, index) for score, index in scored if score > 0]
    if not matches:
        return text
    selected: set[int] = set()
    for _, index in sorted(matches, reverse=True)[:8]:
        selected.update(
            range(max(0, index - radius), min(len(paragraphs), index + radius + 1))
        )
    return "\n\n".join(paragraphs[index] for index in sorted(selected))


def query_term_matches(term: str, lowered_text: str) -> bool:
    if term in lowered_text:
        return True
    return term == "context" and "sequence length" in lowered_text
