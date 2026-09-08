"""Verified, standard-library-only reader for tickerdata releases (Python 3.9+).

Hashes detect inconsistent downloads, not an untrusted publisher. Use a trusted
HTTPS/repository URL and pin expected_data_version for reproducible reports.
"""

import argparse
from collections import Counter
from copy import deepcopy
from datetime import date, datetime
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import warnings


SCHEMA_VERSION = "2.0.0"
DATA_FILES = ("instruments.json", "themes.json", "symbol-index.json")
VERSION_RE = re.compile(r"[a-f0-9]{64}")
ID_RE = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")
RECORD_ID_RE = re.compile(r"ins-[a-z0-9]+(?:-[a-z0-9]+)*")
MIC_RE = re.compile(r"[A-Z0-9]{4}")


class SnapshotError(ValueError):
    """The release is malformed, inconsistent, or not the requested version."""


class UnknownSymbol(LookupError):
    """No listing matches the supplied symbol, MIC, provider and status."""


class AmbiguousSymbol(LookupError):
    """Multiple listings match; candidates contains their IDs and listing MICs."""

    def __init__(self, symbol, candidates):
        self.symbol = symbol
        self.candidates = candidates
        detail = ", ".join(
            "{} ({})".format(item["instrument_id"], item["mic"] or "no MIC")
            for item in candidates
        )
        super().__init__("Ambiguous symbol {!r}: {}".format(symbol, detail))


def _require(condition, message):
    if not condition:
        raise SnapshotError(message)


def _object(value, keys, where):
    _require(isinstance(value, dict) and set(value) == set(keys.split()),
             "{}: unexpected or missing fields".format(where))
    return value


def _text(value, where, nullable=False, empty=False):
    if nullable and value is None:
        return
    _require(isinstance(value, str) and (empty or bool(value.strip())),
             "{}: expected text".format(where))


def _identifier(value, where, nullable=False, record=False):
    if nullable and value is None:
        return
    pattern = RECORD_ID_RE if record else ID_RE
    _require(isinstance(value, str) and len(value) <= 100 and
             pattern.fullmatch(value) is not None, "{}: invalid ID".format(where))


def _array(value, where, unique=True):
    _require(isinstance(value, list), "{}: expected array".format(where))
    if unique:
        keys = [json.dumps(item, sort_keys=True, ensure_ascii=False) for item in value]
        _require(len(keys) == len(set(keys)), "{}: duplicate items".format(where))
    return value


def _ids(value, where, record=False):
    for item in _array(value, where):
        _identifier(item, where, record=record)


def _mic(value, where):
    _require(value is None or isinstance(value, str) and MIC_RE.fullmatch(value),
             "{}: invalid MIC".format(where))


def _symbol(value, where):
    _require(isinstance(value, str) and 1 <= len(value) <= 80 and
             not any(char.isspace() for char in value), "{}: invalid symbol".format(where))


def _time(value, where, nullable=True, day=False):
    if nullable and value is None:
        return
    pattern = (r"\d{4}-\d{2}-\d{2}" if day else
               r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z")
    _require(isinstance(value, str) and re.fullmatch(pattern, value),
             "{}: expected {} UTC date".format(where, "calendar" if day else "ISO"))
    try:
        date.fromisoformat(value) if day else datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise SnapshotError("{}: invalid date".format(where)) from exc


def _choice(value, choices, where):
    _require(value in choices, "{}: invalid value".format(where))


def _parse(raw, name):
    _require(isinstance(raw, bytes) and raw.endswith(b"\n"),
             "{}: expected newline-terminated UTF-8 JSON".format(name))

    def pairs(items):
        result = {}
        for key, value in items:
            _require(key not in result, "{}: duplicate JSON key {}".format(name, key))
            result[key] = value
        return result

    def constant(value):
        raise SnapshotError("{}: non-finite JSON number {}".format(name, value))

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise SnapshotError("{}: invalid UTF-8 JSON: {}".format(name, exc)) from exc


def _expected_version(value):
    _require(value is None or isinstance(value, str) and VERSION_RE.fullmatch(value),
             "Expected version must be 64 lowercase hexadecimal characters")


def _manifest(raw, expected_data_version):
    value = _parse(raw, "manifest.json")
    _object(value, "schema_version data_version source_commit generated_at files", "manifest")
    _require(value["schema_version"] == SCHEMA_VERSION,
             "Unsupported manifest schema_version: use a matching historical consumer or "
             "explicitly migrate maintenance source data and publish a new release")
    _expected_version(value["data_version"])
    _require(value["data_version"] is not None, "Manifest data_version is required")
    _require(expected_data_version is None or value["data_version"] == expected_data_version,
             "Release data_version does not match requested version")
    commit = value["source_commit"]
    _require(commit is None or isinstance(commit, str) and
             re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", commit),
             "Invalid source_commit")
    _time(value["generated_at"], "manifest.generated_at", nullable=False)
    _object(value["files"], " ".join(DATA_FILES), "manifest.files")
    for name, info in value["files"].items():
        _object(info, "sha256 bytes", name)
        _require(isinstance(info["sha256"], str) and VERSION_RE.fullmatch(info["sha256"]),
                 "{}: invalid sha256".format(name))
        _require(type(info["bytes"]) is int and info["bytes"] >= 0,
                 "{}: invalid byte count".format(name))
    return value


def _labels(items, where, extra=""):
    result = {}
    names = set()
    for item in _array(items, where):
        _object(item, "id name_zh description aliases " + extra, where)
        _identifier(item["id"], where)
        _require(item["id"] not in result, "{}: duplicate ID".format(where))
        _text(item["name_zh"], where)
        _text(item["description"], where, empty=True)
        aliases = _array(item["aliases"], where)
        for name in [item["name_zh"]] + aliases:
            _text(name, where)
            normalized = name.strip().lower()
            _require(normalized not in names, "{}: duplicate label or alias".format(where))
            names.add(normalized)
        result[item["id"]] = item
    return result


def _vocabulary(value):
    themes = _labels(value["themes"], "themes")
    tags = _labels(value["tags"], "tags")
    systems = _labels(value["industry_systems"], "industry_systems", "sectors industry_groups industries")
    for system in systems.values():
        sectors = _labels(system["sectors"], "sectors")
        groups = _labels(system["industry_groups"], "industry_groups", "sector_id")
        for group in groups.values():
            _identifier(group["sector_id"], "industry_group.sector_id")
            _require(group["sector_id"] in sectors, "Industry group references unknown sector")
        industries = _labels(system["industries"], "industries", "sector_id industry_group_id")
        for industry in industries.values():
            _identifier(industry["sector_id"], "industry.sector_id", nullable=True)
            _require(industry["sector_id"] is None or industry["sector_id"] in sectors,
                     "Industry references unknown sector")
            _identifier(industry["industry_group_id"], "industry.industry_group_id", nullable=True)
            _require(industry["industry_group_id"] is None or industry["industry_group_id"] in groups,
                     "Industry references unknown industry group")
            group = groups.get(industry["industry_group_id"])
            _require(not group or industry["sector_id"] is None or
                     group["sector_id"] == industry["sector_id"], "Industry group/sector mismatch")
            _require(system["id"] != "financedatabase" or
                     industry["sector_id"] is not None and industry["industry_group_id"] is not None,
                     "FinanceDatabase industry requires sector and industry group parents")
    return themes, tags, systems


def _record(value, themes, tags, systems):
    _object(value, "schema_version id symbol name security_type issuer listing_status "
            "industry classification etf related_instrument_ids notes sources review", "instrument")
    _require(value["schema_version"] == SCHEMA_VERSION, "Unsupported instrument schema_version")
    _identifier(value["id"], "instrument.id", record=True)
    _choice(value["security_type"], ("stock", "etf", "other"), "security_type")
    _choice(value["listing_status"], ("active", "inactive", "unknown"), "listing_status")
    _text(value["notes"], "notes", empty=True)
    _ids(value["related_instrument_ids"], "related_instrument_ids", record=True)
    symbol = _object(value["symbol"], "original canonical mic aliases history", "symbol")
    _symbol(symbol["original"], "symbol.original")
    _symbol(symbol["canonical"], "symbol.canonical")
    _require(symbol["canonical"] == symbol["canonical"].strip().upper(),
             "Canonical symbol must be uppercase and trimmed")
    _mic(symbol["mic"], "symbol.mic")
    own_aliases = set()
    for alias in _array(symbol["aliases"], "symbol.aliases"):
        _object(alias, "provider symbol", "alias")
        _identifier(alias["provider"], "alias.provider")
        _symbol(alias["symbol"], "alias.symbol")
        key = (alias["provider"], alias["symbol"].upper())
        _require(key not in own_aliases, "Duplicate normalized provider alias")
        own_aliases.add(key)
    for item in _array(symbol["history"], "symbol.history"):
        _object(item, "symbol mic valid_from valid_to", "history")
        _symbol(item["symbol"], "history.symbol")
        _mic(item["mic"], "history.mic")
        _time(item["valid_from"], "history.valid_from", day=True)
        _time(item["valid_to"], "history.valid_to", day=True)
        _require(not item["valid_from"] or not item["valid_to"] or
                 item["valid_from"] <= item["valid_to"], "Invalid historical date range")
    name = _object(value["name"], "en zh", "name")
    for text in name.values():
        _text(text, "name", nullable=True)
    issuer = _object(value["issuer"], "id country", "issuer")
    _identifier(issuer["id"], "issuer.id", nullable=True)
    _require(issuer["country"] is None or isinstance(issuer["country"], str) and
             re.fullmatch(r"[A-Z]{2}", issuer["country"]), "Invalid issuer country")
    review = _object(value["review"], "status reviewed_at reviewer", "review")
    _require(review["status"] == "reviewed", "Release contains an unreviewed record")
    _time(review["reviewed_at"], "review.reviewed_at", nullable=False)
    _text(review["reviewer"], "review.reviewer")
    _require(bool(name["en"]) and bool(symbol["mic"]), "Reviewed record needs English name and MIC")

    sources = {}
    for source in _array(value["sources"], "sources"):
        _object(source, "id kind label url accessed_at fields", "source")
        _identifier(source["id"], "source.id")
        _require(source["id"] not in sources, "Duplicate source ID")
        _choice(source["kind"], ("manual", "issuer", "exchange", "provider", "other"), "source.kind")
        _text(source["label"], "source.label")
        url = source["url"]
        _require(url is None or isinstance(url, str) and
                 re.fullmatch(r"https?://[^\s]+", url), "Invalid source URL")
        _time(source["accessed_at"], "source.accessed_at")
        _array(source["fields"], "source.fields")
        _require(bool(source["fields"]), "Source must cover fields")
        for field in source["fields"]:
            _choice(field, ("/industry", "/classification", "/etf", "/name", "/symbol",
                            "/issuer", "/listing_status", "/notes"), "source.fields")
        sources[source["id"]] = source

    industry = _object(value["industry"], "system_id sector_id industry_group_id industry_id source_ids", "industry")
    hierarchy = ("system_id", "sector_id", "industry_group_id", "industry_id")
    for key in hierarchy:
        _identifier(industry[key], "industry." + key, nullable=True)
    system = systems.get(industry["system_id"])
    _require(industry["system_id"] is None or system is not None, "Unknown industry system")
    sectors = {item["id"]: item for item in system["sectors"]} if system else {}
    groups = {item["id"]: item for item in system["industry_groups"]} if system else {}
    industries = {item["id"]: item for item in system["industries"]} if system else {}
    _require(industry["sector_id"] is None or industry["sector_id"] in sectors, "Unknown sector")
    _require(industry["industry_group_id"] is None or industry["industry_group_id"] in groups,
             "Unknown industry group")
    _require(industry["industry_id"] is None or industry["industry_id"] in industries, "Unknown industry")
    label = industries.get(industry["industry_id"])
    _require(not label or not label["sector_id"] or not industry["sector_id"] or
             label["sector_id"] == industry["sector_id"], "Industry/sector mismatch")
    group = groups.get(industry["industry_group_id"])
    parent_group = groups.get(label["industry_group_id"]) if label else None
    _require(not group or not label or not label["sector_id"] or
             group["sector_id"] == label["sector_id"], "Selected industry group and industry belong to different sectors")
    _require(not group or industry["sector_id"] is None or
             group["sector_id"] == industry["sector_id"], "Industry group/sector mismatch")
    _require(not label or not label["industry_group_id"] or not industry["industry_group_id"] or
             label["industry_group_id"] == industry["industry_group_id"], "Industry/group mismatch")
    _require(not parent_group or industry["sector_id"] is None or
             parent_group["sector_id"] == industry["sector_id"], "Industry parent group/sector mismatch")

    classification = _object(value["classification"], "primary_theme_id tag_ids source_ids",
                             "classification")
    _identifier(classification["primary_theme_id"], "primary_theme_id")
    _require(classification["primary_theme_id"] in themes, "Missing primary theme")
    _ids(classification["tag_ids"], "classification.tag_ids")
    _require(all(item in tags for item in classification["tag_ids"]), "Unknown tag")
    _ids(classification["source_ids"], "classification.source_ids")
    _require(bool(classification["source_ids"]), "Reviewed classification needs source")
    _ids(industry["source_ids"], "industry.source_ids")
    _require(not any(industry[key] is not None for key in hierarchy)
             or bool(industry["source_ids"]), "Industry needs source")

    etf = value["etf"]
    if value["security_type"] == "etf":
        _object(etf, "objective asset_class exposure leverage_factor direction reset_period "
                "fund_category description source_ids", "etf")
        _require(all(industry[key] is None for key in hierarchy)
                 and not industry["source_ids"], "ETF must not have company industry")
        for key in ("objective", "fund_category", "description"):
            _text(etf[key], "etf." + key, nullable=True)
        _choice(etf["asset_class"], ("equity", "fixed_income", "commodity", "digital_asset",
                                    "multi_asset", "other", None), "etf.asset_class")
        _choice(etf["direction"], ("long", "short", "neutral", None), "etf.direction")
        _choice(etf["reset_period"], ("daily", "monthly", "none", "other", None), "etf.reset_period")
        for item in _array(etf["exposure"], "etf.exposure"):
            _text(item, "etf.exposure")
        leverage = etf["leverage_factor"]
        _require(leverage is None or type(leverage) in (int, float) and
                 math.isfinite(leverage) and leverage > 0, "Invalid leverage factor")
        if leverage is not None:
            _require(etf["direction"] is not None and etf["reset_period"] is not None,
                     "Leverage needs direction and reset period")
            _require(leverage <= 1 or etf["direction"] != "neutral" and etf["reset_period"] != "none",
                     "Leveraged ETF needs directional exposure and reset period")
        _ids(etf["source_ids"], "etf.source_ids")
        _require(not any(item is not None and item != [] for key, item in etf.items()
                         if key != "source_ids") or bool(etf["source_ids"]), "ETF attributes need source")
    else:
        _require(etf is None, "Non-ETF must not have ETF attributes")
    for field in ("industry", "classification", "etf"):
        for source_id in value[field]["source_ids"] if value[field] is not None else []:
            _require(source_id in sources and "/" + field in sources[source_id]["fields"],
                     "{}: unknown source or source does not cover field".format(field))


def _entry_key(entry):
    return (entry["symbol"], entry["mic"], entry["provider"], entry["instrument_id"], entry["kind"])


def _record_entries(record):
    symbol = record["symbol"]

    def entry(text, mic, provider, kind):
        return {"symbol": text.strip().upper(), "mic": mic, "provider": provider,
                "instrument_id": record["id"], "kind": kind}

    yield entry(symbol["canonical"], symbol["mic"], None, "canonical")
    # An original captured from a provider must not bypass that alias's scope.
    original_scoped = symbol["original"].upper() != symbol["canonical"] and any(
        alias["symbol"].upper() == symbol["original"].upper() for alias in symbol["aliases"])
    if not original_scoped:
        yield entry(symbol["original"], symbol["mic"], None, "original")
    for alias in symbol["aliases"]:
        yield entry(alias["symbol"], symbol["mic"], alias["provider"], "alias")
    for item in symbol["history"]:
        yield entry(item["symbol"], item["mic"], None, "historical")


class Snapshot:
    """Fully validated release with provenance and explicit lookup outcomes."""

    def __init__(self, files, expected_data_version=None):
        _expected_version(expected_data_version)
        _object(files, "manifest.json " + " ".join(DATA_FILES), "snapshot files")
        self._manifest = _manifest(files["manifest.json"], expected_data_version)
        self.data_version = self._manifest["data_version"]
        self.schema_version = SCHEMA_VERSION
        self.source_commit = self._manifest["source_commit"]
        self.generated_at = self._manifest["generated_at"]
        self.used_cache = False
        self.warning = None
        payloads = {}
        for name in DATA_FILES:
            raw = files[name]
            info = self._manifest["files"][name]
            _require(isinstance(raw, bytes), "{}: expected raw bytes".format(name))
            _require(len(raw) == info["bytes"], "{}: byte count mismatch".format(name))
            _require(hashlib.sha256(raw).hexdigest() == info["sha256"],
                     "{}: SHA-256 mismatch".format(name))
            payload = _parse(raw, name)
            fields = {"instruments.json": "instruments", "themes.json": "themes tags industry_systems",
                      "symbol-index.json": "entries"}[name]
            _object(payload, "schema_version data_version " + fields, name)
            _require(payload["schema_version"] == SCHEMA_VERSION, "{}: schema_version mismatch".format(name))
            _require(payload["data_version"] == self.data_version, "{}: data_version mismatch".format(name))
            payloads[name] = payload
        self._themes, tags, systems = _vocabulary(payloads["themes.json"])
        self._records = {}
        expected = Counter()
        identifiers = {}
        for record in _array(payloads["instruments.json"]["instruments"], "instruments", unique=False):
            _record(record, self._themes, tags, systems)
            _require(record["id"] not in self._records, "Duplicate instrument ID")
            self._records[record["id"]] = record
            for entry in _record_entries(record):
                expected.update([_entry_key(entry)])
                if record["listing_status"] == "inactive" or entry["kind"] == "historical":
                    continue
                key = (entry["symbol"], entry["mic"])
                prior = identifiers.setdefault(key, [])
                for other in prior:
                    overlaps = (other["provider"] is None or entry["provider"] is None or
                                other["provider"] == entry["provider"])
                    _require(other["instrument_id"] == record["id"] or not overlaps,
                             "Conflicting non-inactive symbol/MIC/provider identifiers")
                prior.append(entry)
        for record in self._records.values():
            _require(all(item != record["id"] and item in self._records
                         for item in record["related_instrument_ids"]), "Unknown or self-related instrument")
        entries = _array(payloads["symbol-index.json"]["entries"], "entries", unique=False)
        actual = Counter()
        self._index = {}
        for entry in entries:
            _object(entry, "symbol mic provider instrument_id kind", "index entry")
            _symbol(entry["symbol"], "entry.symbol")
            _require(entry["symbol"] == entry["symbol"].strip().upper(), "Index symbol is not normalized")
            _mic(entry["mic"], "entry.mic")
            _identifier(entry["provider"], "entry.provider", nullable=True)
            _identifier(entry["instrument_id"], "entry.instrument_id", record=True)
            _choice(entry["kind"], ("canonical", "original", "alias", "historical"), "entry.kind")
            actual.update([_entry_key(entry)])
            self._index.setdefault(entry["symbol"], []).append(entry)
        _require(actual == expected, "Symbol index does not exactly match instrument symbol/MIC/provider/kind values")
        self._files = dict(files)

    def lookup(self, symbol, mic=None, provider=None, include_inactive=True):
        """Return {instrument, primary_theme}; never rewrite dots or hyphens.

        No provider admits every provider alias; an explicit provider admits its
        own aliases plus unscoped symbols. active-only means listing_status=active.
        Returned metadata is a copy, so callers cannot mutate this snapshot.
        """
        _text(symbol, "query symbol")
        normalized = symbol.strip().upper()
        if mic is not None:
            _text(mic, "query MIC")
            mic = mic.strip().upper()
            _mic(mic, "query MIC")
        if provider is not None:
            _text(provider, "query provider")
            provider = provider.strip().lower()
            _identifier(provider, "query provider")
        candidates = {}
        for entry in self._index.get(normalized, []):
            record = self._records[entry["instrument_id"]]
            if mic is not None and entry["mic"] != mic:
                continue
            if provider is not None and entry["provider"] not in (None, provider):
                continue
            if not include_inactive and record["listing_status"] != "active":
                continue
            candidates[record["id"]] = record
        if not candidates:
            raise UnknownSymbol("Unknown symbol {!r} (MIC={!r}, provider={!r}, active_only={})".format(
                normalized, mic, provider, not include_inactive))
        if len(candidates) > 1:
            raise AmbiguousSymbol(normalized, [
                {"instrument_id": key, "mic": candidates[key]["symbol"]["mic"]}
                for key in sorted(candidates)
            ])
        record = next(iter(candidates.values()))
        theme_id = record["classification"]["primary_theme_id"]
        return deepcopy({"instrument": record, "primary_theme": self._themes[theme_id]})


def load_snapshot(path, expected_data_version=None):
    """Read and verify a local snapshot directory. Does not use fallback."""
    _expected_version(expected_data_version)
    directory = Path(path)
    files = {"manifest.json": (directory / "manifest.json").read_bytes()}
    _manifest(files["manifest.json"], expected_data_version)
    files.update({name: (directory / name).read_bytes() for name in DATA_FILES})
    return Snapshot(files, expected_data_version)


def _cached_snapshot(cache, expected_data_version):
    if expected_data_version is None:
        try:
            version = (cache / "current").read_text(encoding="utf-8").strip()
        except UnicodeError as exc:
            raise SnapshotError("Invalid cache current pointer") from exc
    else:
        version = expected_data_version
    _expected_version(version)
    return load_snapshot(cache / "snapshots" / version, version)


def _persist(snapshot, cache):
    snapshots = cache / "snapshots"
    snapshots.mkdir(parents=True, exist_ok=True)
    destination = snapshots / snapshot.data_version
    stage = Path(tempfile.mkdtemp(prefix=".download-", dir=str(snapshots)))
    try:
        for name, raw in snapshot._files.items():
            with (stage / name).open("wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
        if destination.exists():
            existing = load_snapshot(destination, snapshot.data_version)
            _require(existing._files == snapshot._files, "Existing cached version has different bytes")
        else:
            try:
                stage.rename(destination)
            except OSError:
                # A concurrent writer may have published this immutable version.
                if not destination.is_dir():
                    raise
                existing = load_snapshot(destination, snapshot.data_version)
                _require(existing._files == snapshot._files, "Concurrent cached version has different bytes")
        pointer = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".current-",
                                             dir=str(cache), delete=False) as stream:
                pointer = Path(stream.name)
                stream.write(snapshot.data_version + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(str(pointer), str(cache / "current"))
        finally:
            if pointer is not None and pointer.exists():
                pointer.unlink()
    finally:
        if stage.exists():
            shutil.rmtree(stage)


_FETCH_ERRORS = (OSError, urllib.error.URLError, http.client.HTTPException, SnapshotError)


def fetch_snapshot(url, cache=None, expected_data_version=None, timeout=10):
    """Fetch manifest then files, verify everything, and atomically cache.

    On network/integrity/cache-write failure, an explicitly supplied valid cache
    may be returned with RuntimeWarning, used_cache=True and warning text.
    A version pin permits fallback only to that exact cached version.
    """
    _expected_version(expected_data_version)
    _require(isinstance(url, str), "URL must be text")
    parsed = urllib.parse.urlsplit(url)
    _require(parsed.scheme in ("https", "http") and bool(parsed.netloc) and
             not parsed.query and not parsed.fragment, "Expected an HTTP(S) directory URL without query or fragment")
    _require(type(timeout) in (int, float) and math.isfinite(timeout) and timeout > 0,
             "Timeout must be a positive finite number")
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        warnings.warn("External plaintext HTTP is not authenticated; prefer trusted HTTPS.",
                      RuntimeWarning, stacklevel=2)
    base = url.rstrip("/") + "/"
    cache_path = Path(cache) if cache is not None else None
    prior_snapshot = None
    if cache_path is not None:
        try:
            prior_snapshot = _cached_snapshot(cache_path, expected_data_version)
        except FileNotFoundError:
            prior_snapshot = None
        except _FETCH_ERRORS as exc:
            warnings.warn("Cached snapshot is unusable; attempting a fresh download: {}".format(exc),
                          RuntimeWarning, stacklevel=2)
    try:
        def download(name):
            with urllib.request.urlopen(base + name, timeout=timeout) as response:
                return response.read()

        files = {"manifest.json": download("manifest.json")}
        _manifest(files["manifest.json"], expected_data_version)
        files.update({name: download(name) for name in DATA_FILES})
        snapshot = Snapshot(files, expected_data_version)
        if cache_path is not None:
            _persist(snapshot, cache_path)
        return snapshot
    except _FETCH_ERRORS as exc:
        if prior_snapshot is None:
            raise
        snapshot = prior_snapshot
        snapshot.used_cache = True
        snapshot.warning = "Using verified cached snapshot {} after fetch failure: {}".format(
            snapshot.data_version, exc)
        warnings.warn(snapshot.warning, RuntimeWarning, stacklevel=2)
        return snapshot


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", help="Local release directory")
    source.add_argument("--url", help="HTTPS release directory (HTTP allowed for localhost)")
    parser.add_argument("--cache", help="Explicit cache directory for downloads and offline fallback")
    parser.add_argument("--version", help="Require this exact data_version, including offline fallback")
    parser.add_argument("--timeout", type=float, default=10, help="HTTP timeout in seconds (default: 10)")
    parser.add_argument("--mic")
    parser.add_argument("--provider")
    parser.add_argument("--active-only", action="store_true")
    parser.add_argument("symbol")
    args = parser.parse_args(argv)
    try:
        snapshot = (load_snapshot(args.snapshot, args.version) if args.snapshot else
                    fetch_snapshot(args.url, args.cache, args.version, args.timeout))
        result = snapshot.lookup(args.symbol, args.mic, args.provider, not args.active_only)
        result["snapshot"] = {
            "schema_version": snapshot.schema_version, "data_version": snapshot.data_version,
            "source_commit": snapshot.source_commit, "generated_at": snapshot.generated_at,
            "used_cache": snapshot.used_cache, "warning": snapshot.warning,
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False))
        return 0
    except (UnknownSymbol, AmbiguousSymbol) + _FETCH_ERRORS + (ValueError,) as exc:
        print("error: {}".format(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
