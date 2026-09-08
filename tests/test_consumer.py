"""Consumer contract tests; no network, third-party packages or default temp dir."""

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error
import warnings

from examples import consumer


VERSION = "a" * 64
NEXT_VERSION = "b" * 64


def record(identifier="ins-example", symbol="TEST", mic="XNAS"):
    return {
        "schema_version": "3.0.0", "id": identifier,
        "symbol": {"original": symbol, "canonical": symbol, "mic": mic,
                   "aliases": [], "history": []},
        "name": {"en": "Example security", "zh": None},
        "security_type": "stock", "issuer": {"id": None, "country": "TW"},
        "listing_status": "active",
        "industry": {"system_id": None, "sector_id": None, "industry_group_id": None,
                     "industry_id": None, "source_ids": []},
        "classification": {"tag_ids": ["cloud", "ai"], "source_ids": ["human"]},
        "etf": None, "related_instrument_ids": [], "notes": "",
        "sources": [{"id": "human", "kind": "manual", "label": "Reviewed tag evidence",
                     "url": None, "accessed_at": None, "fields": ["/classification"]}],
        "review": {"status": "reviewed", "reviewed_at": "2026-09-01T00:00:00Z",
                   "reviewer": "Human reviewer"},
    }


def label(identifier, name):
    return {"id": identifier, "name_zh": name, "description": "", "aliases": []}


def vocabulary():
    return {"tags": [label("cloud", "云计算"), label("ai", "AI")],
            "industry_systems": [
                dict(label("standard", "标准"), sectors=[label("technology", "科技")],
                     industry_groups=[],
                     industries=[dict(label("software", "软件"), sector_id="technology",
                                      industry_group_id=None)])
            ]}


def encode(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def entries(records):
    result = []
    for item in records:
        symbol = item["symbol"]
        canonical = symbol["canonical"].strip().upper()
        original = symbol["original"].strip().upper()
        for text, mic, provider, kind in (
            [(canonical, symbol["mic"], None, "canonical")] +
            ([(original, symbol["mic"], None, "original")] if canonical == original or not any(
                alias["symbol"].strip().upper() == original for alias in symbol["aliases"]) else []) +
            [(alias["symbol"].strip().upper(), symbol["mic"], alias["provider"], "alias")
             for alias in symbol["aliases"]] +
            [(old["symbol"].strip().upper(), old["mic"], None, "historical")
             for old in symbol["history"]]
        ):
            result.append({"symbol": text, "mic": mic, "provider": provider,
                           "instrument_id": item["id"], "kind": kind})
    return result


def bundle(records=None, version=VERSION):
    records = [record()] if records is None else records
    envelope = {"schema_version": "3.0.0", "data_version": version}
    files = {
        "instruments.json": encode(dict(envelope, instruments=records)),
        "vocabulary.json": encode(dict(envelope, **vocabulary())),
        "symbol-index.json": encode(dict(envelope, entries=entries(records))),
    }
    files["manifest.json"] = encode(dict(
        envelope, source_commit="c" * 40, generated_at="2026-09-01T00:00:00.000Z",
        files={name: {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
               for name, raw in files.items()}))
    return files


def change_payload(files, name, mutation):
    result = deepcopy(files)
    value = json.loads(result[name])
    mutation(value)
    result[name] = encode(value)
    if name != "manifest.json":
        manifest = json.loads(result["manifest.json"])
        manifest["files"][name] = {
            "sha256": hashlib.sha256(result[name]).hexdigest(), "bytes": len(result[name])}
        result["manifest.json"] = encode(manifest)
    return result


def write_bundle(path, files):
    path.mkdir(parents=True, exist_ok=True)
    for name, raw in files.items():
        (path / name).write_bytes(raw)


def download_from(files):
    def read(url, timeout):
        return io.BytesIO(files[url.rsplit("/", 1)[-1]])
    return read


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(
            prefix=".consumer-test-", dir=str(Path(__file__).resolve().parents[1]))
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.files = bundle()

    def test_local_snapshot_provenance_and_deep_copy(self):
        write_bundle(self.root, self.files)
        snapshot = consumer.load_snapshot(self.root)
        result = snapshot.lookup(" \ttest\n", mic=" xnas ")
        self.assertEqual(result["instrument"]["id"], "ins-example")
        self.assertEqual(result["instrument"]["issuer"]["country"], "TW")
        self.assertEqual(set(result), {"instrument", "tags"})
        self.assertNotIn("primary_theme_id", result["instrument"]["classification"])
        self.assertEqual(result["tags"], vocabulary()["tags"])
        self.assertEqual(snapshot.schema_version, "3.0.0")
        self.assertEqual(snapshot.data_version, VERSION)
        self.assertEqual(snapshot.source_commit, "c" * 40)
        self.assertEqual(snapshot.generated_at, "2026-09-01T00:00:00.000Z")
        self.assertFalse(snapshot.used_cache)
        self.assertIsNone(snapshot.warning)
        result["instrument"]["symbol"]["canonical"] = "MUTATED"
        result["tags"][0]["name_zh"] = "MUTATED"
        result["tags"][1]["aliases"].append("MUTATED")
        result["instrument"]["classification"]["tag_ids"].clear()
        self.assertEqual(snapshot.lookup("TEST")["tags"], vocabulary()["tags"])
        self.assertEqual(snapshot.lookup("TEST")["instrument"]["symbol"]["canonical"], "TEST")

    def test_provider_scoping_preserves_punctuation_and_original(self):
        berkshire = record("ins-brkb", "BRK.B", "XNYS")
        berkshire["symbol"]["original"] = "BRK-B"
        berkshire["symbol"]["aliases"] = [{"provider": "yahoo", "symbol": "brk-b"}]
        hk = record("ins-hk", "0700.HK", "XHKG")
        snapshot = consumer.Snapshot(bundle([berkshire, hk]))
        for provider in (None, "yahoo", " Yahoo "):
            self.assertEqual(snapshot.lookup("brk-b", provider=provider)["instrument"]["id"], "ins-brkb")
        self.assertEqual(snapshot.lookup("BRK.B", provider="other")["instrument"]["id"], "ins-brkb")
        self.assertEqual(snapshot.lookup("0700.hk")["instrument"]["id"], "ins-hk")
        for symbol, provider in (("BRK-B", "other"), ("BRKB", None), ("0700-HK", None), ("700.HK", None)):
            with self.subTest(symbol=symbol, provider=provider), self.assertRaises(consumer.UnknownSymbol):
                snapshot.lookup(symbol, provider=provider)

    def test_original_symbol_and_share_classes(self):
        original = record("ins-original", "CURRENT")
        original["symbol"]["original"] = "Original"
        snapshot = consumer.Snapshot(bundle([
            original, record("ins-goog", "GOOG"), record("ins-googl", "GOOGL")]))
        self.assertEqual(snapshot.lookup("original", provider="any")["instrument"]["id"], "ins-original")
        self.assertEqual(snapshot.lookup("GOOG")["instrument"]["id"], "ins-goog")
        self.assertEqual(snapshot.lookup("GOOGL")["instrument"]["id"], "ins-googl")

    def test_mic_ambiguity_has_deterministic_candidates(self):
        snapshot = consumer.Snapshot(bundle([
            record("ins-z", "SAME", "XNYS"), record("ins-a", "SAME", "XNAS")]))
        with self.assertRaises(consumer.AmbiguousSymbol) as raised:
            snapshot.lookup("same")
        self.assertEqual(raised.exception.candidates, [
            {"instrument_id": "ins-a", "mic": "XNAS"}, {"instrument_id": "ins-z", "mic": "XNYS"}])
        self.assertIn("ins-z (XNYS)", str(raised.exception))
        self.assertEqual(snapshot.lookup("same", mic=" xnys ")["instrument"]["id"], "ins-z")
        with self.assertRaises(consumer.UnknownSymbol):
            snapshot.lookup("same", mic="XLON")

    def test_provider_disambiguation_and_canonical_inclusion(self):
        first = record("ins-first", "ONE")
        second = record("ins-second", "TWO")
        first["symbol"]["aliases"] = [{"provider": "yahoo", "symbol": "SHARED"}]
        second["symbol"]["aliases"] = [{"provider": "other", "symbol": "SHARED"}]
        snapshot = consumer.Snapshot(bundle([first, second]))
        with self.assertRaises(consumer.AmbiguousSymbol):
            snapshot.lookup("shared")
        self.assertEqual(snapshot.lookup("shared", provider="yahoo")["instrument"]["id"], "ins-first")
        self.assertEqual(snapshot.lookup("ONE", provider="other")["instrument"]["id"], "ins-first")

    def test_historical_mic_and_inactive_reuse(self):
        archived = record("ins-archived", "NEW", "XNYS")
        archived["listing_status"] = "inactive"
        archived["symbol"]["history"] = [
            {"symbol": "OLD", "mic": "XNAS", "valid_from": "2000-01-01", "valid_to": "2010-01-01"}]
        current = record("ins-current", "OLD", "XNAS")
        snapshot = consumer.Snapshot(bundle([archived, current]))
        with self.assertRaises(consumer.AmbiguousSymbol):
            snapshot.lookup("OLD", mic="XNAS")
        self.assertEqual(snapshot.lookup("old", include_inactive=False)["instrument"]["id"], "ins-current")
        self.assertEqual(snapshot.lookup("new")["instrument"]["listing_status"], "inactive")
        with self.assertRaises(consumer.UnknownSymbol):
            snapshot.lookup("new", include_inactive=False)
        with self.assertRaises(consumer.UnknownSymbol):
            snapshot.lookup("old", mic="XNYS")
        archived["symbol"]["canonical"] = "OLD"
        archived["symbol"]["original"] = "OLD"
        archived["symbol"]["mic"] = "XNAS"
        with self.assertRaises(consumer.AmbiguousSymbol):
            consumer.Snapshot(bundle([archived, current])).lookup("old")

    def test_active_only_excludes_unknown_listing_status(self):
        item = record()
        item["listing_status"] = "unknown"
        snapshot = consumer.Snapshot(bundle([item]))
        self.assertEqual(snapshot.lookup("test")["instrument"]["id"], item["id"])
        with self.assertRaises(consumer.UnknownSymbol):
            snapshot.lookup("test", include_inactive=False)

    def test_duplicate_entries_for_same_record_do_not_ambiguate(self):
        item = record()
        item["symbol"]["aliases"] = [{"provider": "yahoo", "symbol": "TEST"}]
        item["symbol"]["history"] = [
            {"symbol": "TEST", "mic": "XNAS", "valid_from": "2000-01-01", "valid_to": "2010-01-01"},
            {"symbol": "TEST", "mic": "XNAS", "valid_from": "2011-01-01", "valid_to": "2012-01-01"}]
        self.assertEqual(consumer.Snapshot(bundle([item])).lookup("test")["instrument"]["id"], item["id"])

    def test_conflicting_non_inactive_identifiers_are_rejected(self):
        with self.assertRaisesRegex(consumer.SnapshotError, "Conflicting"):
            consumer.Snapshot(bundle([record(), record("ins-second")]))
        first = record()
        second = record("ins-second", "SECOND")
        second["symbol"]["aliases"] = [{"provider": "yahoo", "symbol": "TEST"}]
        with self.assertRaisesRegex(consumer.SnapshotError, "Conflicting"):
            consumer.Snapshot(bundle([first, second]))

    def test_empty_reviewed_release_is_valid_but_lookup_is_unknown(self):
        with self.assertRaises(consumer.UnknownSymbol):
            consumer.Snapshot(bundle([])).lookup("TEST")

    def test_reviewed_record_without_tags_preserves_review_requirements(self):
        item = record()
        item["classification"] = {"tag_ids": [], "source_ids": []}
        item["sources"] = []
        snapshot = consumer.Snapshot(bundle([item]))
        self.assertEqual(snapshot.lookup("TEST"), {"instrument": item, "tags": []})
        for field, value in (("reviewer", None), ("reviewed_at", None), ("status", "pending")):
            broken = deepcopy(item)
            broken["review"][field] = value
            with self.subTest(field=field), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(bundle([broken]))
        for field, value in (("name", {"en": None, "zh": None}),
                             ("symbol", dict(item["symbol"], mic=None))):
            broken = dict(item, **{field: value})
            with self.subTest(field=field), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(bundle([broken]))

    def test_multiple_tags_are_nonexclusive_and_resolve_in_record_order(self):
        item = record()
        item["classification"]["tag_ids"] = ["ai", "cloud"]
        second = record("ins-second", "SECOND")
        second["classification"]["tag_ids"] = ["cloud"]
        snapshot = consumer.Snapshot(bundle([item, second]))
        result = snapshot.lookup("TEST")
        self.assertEqual(set(result), {"instrument", "tags"})
        self.assertEqual(result["tags"], list(reversed(vocabulary()["tags"])))
        self.assertEqual(snapshot.lookup("SECOND")["tags"], vocabulary()["tags"][:1])
        self.assertTrue(all(set(tag) == {"id", "name_zh", "description", "aliases"}
                            for tag in result["tags"]))

    def test_classification_requires_known_unique_tags_and_covering_sources(self):
        for classification, fields in (
            ({"tag_ids": ["missing"], "source_ids": ["human"]}, ["/classification"]),
            ({"tag_ids": ["ai", "ai"], "source_ids": ["human"]}, ["/classification"]),
            ({"tag_ids": ["ai"], "source_ids": []}, ["/classification"]),
            ({"tag_ids": ["ai"], "source_ids": ["missing"]}, ["/classification"]),
            ({"tag_ids": ["ai"], "source_ids": ["human", "human"]}, ["/classification"]),
            ({"tag_ids": ["ai"], "source_ids": ["human"]}, ["/name"]),
            ({"tag_ids": [], "source_ids": ["missing"]}, ["/classification"]),
            ({"tag_ids": [], "source_ids": ["human"]}, ["/name"]),
        ):
            item = record()
            item["classification"] = classification
            item["sources"][0]["fields"] = fields
            with self.subTest(classification=classification, fields=fields), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(bundle([item]))
        item = record()
        item["classification"]["tag_ids"] = []
        self.assertEqual(consumer.Snapshot(bundle([item])).lookup("TEST")["tags"], [])

    def test_etf_without_company_industry_and_unknown_attributes(self):
        item = record("ins-etf", "FUND")
        item["security_type"] = "etf"
        item["etf"] = {
            "objective": None, "asset_class": None, "exposure": [], "leverage_factor": None,
            "direction": None, "reset_period": None, "fund_category": None, "description": None,
            "source_ids": []}
        result = consumer.Snapshot(bundle([item])).lookup("FUND")
        self.assertIsNone(result["instrument"]["industry"]["industry_id"])
        self.assertIsNone(result["instrument"]["etf"]["leverage_factor"])
        self.assertEqual([tag["id"] for tag in result["tags"]], ["cloud", "ai"])
        item["industry"]["system_id"] = "standard"
        item["industry"]["source_ids"] = ["human"]
        item["sources"][0]["fields"].append("/industry")
        with self.assertRaisesRegex(consumer.SnapshotError, "ETF"):
            consumer.Snapshot(bundle([item]))

    def test_industry_and_field_level_source_validation(self):
        item = record()
        item["industry"] = {"system_id": "standard", "sector_id": "technology", "industry_group_id": None,
                            "industry_id": "software", "source_ids": ["human"]}
        item["sources"][0]["fields"].append("/industry")
        self.assertEqual(consumer.Snapshot(bundle([item])).lookup("TEST")["instrument"]["industry"],
                         item["industry"])
        for key in ("system_id", "sector_id", "industry_group_id", "industry_id"):
            broken = deepcopy(item)
            broken["industry"][key] = "missing"
            with self.subTest(key=key), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(bundle([broken]))
        item["sources"][0]["fields"].remove("/industry")
        with self.assertRaisesRegex(consumer.SnapshotError, "source"):
            consumer.Snapshot(bundle([item]))

    def test_manifest_requires_exact_file_set(self):
        self.assertEqual(consumer.DATA_FILES,
                         ("instruments.json", "vocabulary.json", "symbol-index.json"))
        self.assertNotIn("themes.json", self.files)
        for mutation in (
            lambda value: value["files"].pop("vocabulary.json"),
            lambda value: value["files"].update({"themes.json": value["files"].pop("vocabulary.json")}),
            lambda value: value["files"].update({"../outside.json": {"sha256": VERSION, "bytes": 1}}),
            lambda value: value.update({"unexpected": True}),
            lambda value: value.update({"files": []}),
        ):
            with self.subTest(mutation=mutation), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(change_payload(self.files, "manifest.json", mutation))

    def test_manifest_provenance_and_byte_count_types(self):
        mutations = [
            lambda value: value.update({"data_version": None}),
            lambda value: value.update({"data_version": "A" * 64}),
            lambda value: value.update({"source_commit": "not-a-commit"}),
            lambda value: value.update({"generated_at": "2026-02-30T00:00:00Z"}),
            lambda value: value.update({"generated_at": "2026-09-01T00:00:00+08:00"}),
            lambda value: value["files"]["vocabulary.json"].update({"bytes": True}),
            lambda value: value["files"]["vocabulary.json"].update({"bytes": -1}),
            lambda value: value["files"]["vocabulary.json"].update({"sha256": "x" * 64}),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(change_payload(self.files, "manifest.json", mutation))
        for commit in (None, "d" * 64):
            result = consumer.Snapshot(change_payload(
                self.files, "manifest.json", lambda value: value.update({"source_commit": commit})))
            self.assertEqual(result.source_commit, commit)

    def test_exact_bytes_not_reserialized_json_are_verified(self):
        corrupted = dict(self.files)
        corrupted["instruments.json"] = corrupted["instruments.json"].replace(b"Example", b"Altered")
        with self.assertRaisesRegex(consumer.SnapshotError, "SHA-256"):
            consumer.Snapshot(corrupted)
        corrupted = dict(self.files)
        corrupted["vocabulary.json"] += b" "
        with self.assertRaisesRegex(consumer.SnapshotError, "byte count"):
            consumer.Snapshot(corrupted)

    def test_newline_utf8_duplicate_keys_and_nonfinite_json(self):
        for raw in (
            self.files["manifest.json"].rstrip(b"\n"),
            b"\xff\n", b'{"schema_version":1,"schema_version":2}\n',
            b'{"schema_version":NaN}\n', b"not json\n",
        ):
            with self.subTest(raw=raw[:40]), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(dict(self.files, **{"manifest.json": raw}))
        raw = self.files["vocabulary.json"].rstrip(b"\n")
        broken = dict(self.files, **{"vocabulary.json": raw})
        broken = change_payload(broken, "manifest.json", lambda value: value["files"].update(
            {"vocabulary.json": {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}}))
        with self.assertRaisesRegex(consumer.SnapshotError, "newline"):
            consumer.Snapshot(broken)

    def test_schema_and_data_version_mismatch_every_envelope(self):
        for name in ("manifest.json",) + consumer.DATA_FILES:
            for field, new_value in (("schema_version", "1.0.0"), ("schema_version", "2.0.0"),
                                     ("data_version", NEXT_VERSION)):
                with self.subTest(file=name, field=field), self.assertRaises(consumer.SnapshotError):
                    consumer.Snapshot(change_payload(self.files, name,
                        lambda value: value.update({field: new_value})))
        consumer.Snapshot(self.files, VERSION)
        with self.assertRaises(consumer.SnapshotError):
            consumer.Snapshot(self.files, NEXT_VERSION)

    def test_legacy_releases_require_historical_consumer_or_maintenance_migration(self):
        for version in ("1.0.0", "2.0.0"):
            legacy = deepcopy(self.files)
            legacy["themes.json"] = legacy.pop("vocabulary.json")
            legacy = change_payload(legacy, "manifest.json", lambda value: value.update(
                schema_version=version,
                files={("themes.json" if name == "vocabulary.json" else name): info
                       for name, info in value["files"].items()}))
            guidance = "matching historical consumer or explicitly migrate maintenance source data"
            with self.subTest(version=version):
                with self.assertRaisesRegex(consumer.SnapshotError, guidance):
                    consumer.Snapshot(legacy)
                path = self.root / version
                write_bundle(path, legacy)
                with self.assertRaisesRegex(consumer.SnapshotError, guidance):
                    consumer.load_snapshot(path)
                cache = self.root / ("legacy-cache-" + version)
                with mock.patch.object(consumer.urllib.request, "urlopen",
                                       side_effect=download_from(legacy)) as opened:
                    with self.assertRaisesRegex(consumer.SnapshotError, guidance):
                        consumer.fetch_snapshot("https://example.invalid", cache)
                self.assertEqual(opened.call_count, 1)
                self.assertFalse(cache.exists())
                self.assertEqual((path / "themes.json").read_bytes(), legacy["themes.json"])
                self.assertFalse((path / "vocabulary.json").exists())

    def test_record_shape_review_unique_id_and_dangling_references(self):
        mutations = [
            lambda item: item.pop("name"),
            lambda item: item.update({"extra": 1}),
            lambda item: item.update({"id": "TEST"}),
            lambda item: item.update({"schema_version": "1.0.0"}),
            lambda item: item.update({"schema_version": "2.0.0"}),
            lambda item: item["review"].update({"status": "pending"}),
            lambda item: item["review"].update({"reviewer": None}),
            lambda item: item["review"].update({"reviewed_at": "2026-02-30T00:00:00Z"}),
            lambda item: item["classification"].update({"primary_theme_id": "missing"}),
            lambda item: item["classification"].update({"primary_theme_id": None}),
            lambda item: item["classification"].update({"tag_ids": ["missing"]}),
            lambda item: item["classification"].update({"tag_ids": ["ai", "ai"]}),
            lambda item: item["classification"].update({"source_ids": ["missing"]}),
            lambda item: item["classification"].update({"source_ids": []}),
            lambda item: item.update({"related_instrument_ids": ["ins-missing"]}),
            lambda item: item.update({"related_instrument_ids": ["ins-example"]}),
            lambda item: item["symbol"].update({"canonical": "test"}),
            lambda item: item["symbol"].update({"aliases": [{"provider": None, "symbol": "ALIAS"}]}),
        ]
        for mutation in mutations:
            item = record()
            mutation(item)
            # Change only the source payload; every failure must occur at load, not lookup.
            broken = change_payload(self.files, "instruments.json",
                                    lambda value: value.update({"instruments": [item]}))
            with self.subTest(item=item), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(broken)
        with self.assertRaisesRegex(consumer.SnapshotError, "Duplicate instrument ID"):
            consumer.Snapshot(bundle([record(), record()]))

    def test_vocabulary_references_and_duplicates(self):
        for mutation in (
            lambda value: value.update({"tags": []}),
            lambda value: value.update({"themes": []}),
            lambda value: value["tags"].append(deepcopy(value["tags"][0])),
            lambda value: value["industry_systems"][0]["industries"][0].update({"sector_id": "missing"}),
            lambda value: value["tags"][0].update({"name_zh": ""}),
        ):
            with self.subTest(mutation=mutation), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(change_payload(self.files, "vocabulary.json", mutation))

    def test_every_index_field_must_match_and_index_is_complete(self):
        for field, changed in (
            ("symbol", "WRONG"), ("mic", "XNYS"), ("provider", "yahoo"),
            ("instrument_id", "ins-missing"), ("kind", "alias"), ("kind", "invalid"),
        ):
            broken = change_payload(self.files, "symbol-index.json",
                                    lambda value: value["entries"][0].update({field: changed}))
            with self.subTest(field=field, value=changed), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(broken)
        for mutation in (
            lambda value: value["entries"].pop(),
            lambda value: value["entries"].append(deepcopy(value["entries"][0])),
            lambda value: value["entries"][0].update({"symbol": "test"}),
            lambda value: value["entries"][0].update({"extra": "bad"}),
        ):
            with self.subTest(mutation=mutation), self.assertRaises(consumer.SnapshotError):
                consumer.Snapshot(change_payload(self.files, "symbol-index.json", mutation))

    def test_fetch_order_timeout_cache_and_pointer(self):
        cache = self.root / "cache"
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(self.files)) as opened:
            snapshot = consumer.fetch_snapshot("https://example.invalid/releases/latest", cache, timeout=3)
        self.assertEqual(opened.call_args_list, [
            mock.call("https://example.invalid/releases/latest/" + name, timeout=3)
            for name in ("manifest.json",) + consumer.DATA_FILES])
        self.assertFalse(snapshot.used_cache)
        self.assertEqual((cache / "current").read_text(), VERSION + "\n")
        destination = cache / "snapshots" / VERSION
        for name, raw in self.files.items():
            self.assertEqual((destination / name).read_bytes(), raw)
        self.assertEqual(list(cache.glob(".current-*")), [])
        self.assertEqual(list((cache / "snapshots").glob(".download-*")), [])
        self.assertFalse((destination / "themes.json").exists())
        self.assertEqual(consumer.load_snapshot(destination).lookup("TEST")["tags"], vocabulary()["tags"])

    def test_invalid_manifest_is_rejected_before_downloads_or_cache_creation(self):
        broken = change_payload(self.files, "manifest.json",
                                lambda value: value["files"].update({"extra.json": {}}))
        cache = self.root / "cache"
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(broken)) as opened:
            with self.assertRaises(consumer.SnapshotError):
                consumer.fetch_snapshot("https://example.invalid", cache)
        self.assertEqual(opened.call_count, 1)
        self.assertFalse(cache.exists())

    def test_offline_fallback_is_explicit_and_warns(self):
        cache = self.seed_cache()
        with mock.patch.object(consumer.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("offline")):
            with self.assertWarnsRegex(RuntimeWarning, "verified cached snapshot"):
                snapshot = consumer.fetch_snapshot("https://example.invalid", cache)
        self.assertTrue(snapshot.used_cache)
        self.assertIn("offline", snapshot.warning)
        self.assertEqual(snapshot.data_version, VERSION)
        self.assertEqual(snapshot.lookup("TEST")["instrument"]["id"], "ins-example")

    def test_no_explicit_cache_or_no_valid_prior_cache_raises(self):
        for cache in (None, self.root / "absent"):
            with self.subTest(cache=cache), mock.patch.object(
                    consumer.urllib.request, "urlopen", side_effect=urllib.error.URLError("offline")):
                with self.assertRaises(urllib.error.URLError), warnings.catch_warnings(record=True) as caught:
                    consumer.fetch_snapshot("https://example.invalid", cache)
                self.assertFalse(caught)
        self.assertFalse((self.root / "absent").exists())
        cache = self.seed_cache()
        (cache / "snapshots" / VERSION / "vocabulary.json").write_bytes(b"broken\n")
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=OSError("offline")):
            with self.assertWarnsRegex(RuntimeWarning, "Cached snapshot is unusable"), self.assertRaisesRegex(OSError, "offline"):
                consumer.fetch_snapshot("https://example.invalid", cache)

    def test_mixed_latest_and_semantically_bad_download_preserve_old_snapshot(self):
        cache = self.seed_cache()
        next_files = bundle(version=NEXT_VERSION)
        mixed = dict(next_files, **{"vocabulary.json": self.files["vocabulary.json"]})
        semantic = change_payload(next_files, "instruments.json", lambda value:
                                  value["instruments"][0]["classification"].update({"tag_ids": ["missing"]}))
        for broken in (mixed, semantic):
            with self.subTest(broken=broken), mock.patch.object(
                    consumer.urllib.request, "urlopen", side_effect=download_from(broken)):
                with self.assertWarns(RuntimeWarning):
                    result = consumer.fetch_snapshot("https://example.invalid", cache)
                self.assertTrue(result.used_cache)
                self.assertEqual(result.data_version, VERSION)
                self.assertEqual((cache / "current").read_text(), VERSION + "\n")
                self.assertFalse((cache / "snapshots" / NEXT_VERSION).exists())
            with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(broken)):
                with self.assertRaises(consumer.SnapshotError):
                    consumer.fetch_snapshot("https://example.invalid")
        for name, raw in self.files.items():
            self.assertEqual((cache / "snapshots" / VERSION / name).read_bytes(), raw)

    def test_network_failure_mid_download_leaves_cache_unchanged(self):
        cache = self.seed_cache()
        next_files = bundle(version=NEXT_VERSION)
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=[
                io.BytesIO(next_files["manifest.json"]), io.BytesIO(next_files["instruments.json"]),
                consumer.http.client.IncompleteRead(b"partial")]):
            with self.assertWarns(RuntimeWarning):
                result = consumer.fetch_snapshot("https://example.invalid", cache)
        self.assertEqual(result.data_version, VERSION)
        self.assertFalse((cache / "snapshots" / NEXT_VERSION).exists())

    def test_fixed_version_never_falls_back_to_different_version(self):
        cache = self.seed_cache()
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=OSError("offline")):
            with self.assertRaisesRegex(OSError, "offline"):
                consumer.fetch_snapshot("https://example.invalid", cache, NEXT_VERSION)
            with self.assertWarns(RuntimeWarning):
                result = consumer.fetch_snapshot("https://example.invalid", cache, VERSION)
        self.assertEqual(result.data_version, VERSION)
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(self.files)) as opened:
            with self.assertRaisesRegex(consumer.SnapshotError, "requested version"):
                consumer.fetch_snapshot("https://example.invalid", cache, NEXT_VERSION)
        self.assertEqual(opened.call_count, 1)
        next_files = bundle(version=NEXT_VERSION)
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(next_files)):
            consumer.fetch_snapshot("https://example.invalid", cache)
        # Pinning an older immutable snapshot remains possible after current advances.
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=OSError("offline")):
            with self.assertWarns(RuntimeWarning):
                self.assertEqual(consumer.fetch_snapshot(
                    "https://example.invalid", cache, VERSION).data_version, VERSION)
        self.assertEqual((cache / "current").read_text(), NEXT_VERSION + "\n")

    def test_existing_snapshot_is_verified_not_overwritten(self):
        cache = self.seed_cache()
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(self.files)):
            self.assertFalse(consumer.fetch_snapshot("https://example.invalid", cache).used_cache)
        altered = change_payload(self.files, "instruments.json",
                                 lambda value: value["instruments"][0].update({"notes": "Different bytes"}))
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(altered)):
            with self.assertWarnsRegex(RuntimeWarning, "different bytes"):
                result = consumer.fetch_snapshot("https://example.invalid", cache)
        self.assertEqual(result.lookup("TEST")["instrument"]["notes"], "")
        (cache / "snapshots" / VERSION / "vocabulary.json").write_bytes(b"corrupt\n")
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(self.files)):
            with self.assertWarnsRegex(RuntimeWarning, "Cached snapshot is unusable"), self.assertRaises(consumer.SnapshotError):
                consumer.fetch_snapshot("https://example.invalid", cache)
        self.assertEqual((cache / "snapshots" / VERSION / "vocabulary.json").read_bytes(), b"corrupt\n")
        self.assertEqual(list((cache / "snapshots").glob(".download-*")), [])

    def test_pointer_write_failure_preserves_previous_current(self):
        cache = self.seed_cache()
        with mock.patch.object(consumer.urllib.request, "urlopen",
                               side_effect=download_from(bundle(version=NEXT_VERSION))):
            with mock.patch.object(consumer.os, "replace", side_effect=OSError("disk failure")):
                with self.assertWarnsRegex(RuntimeWarning, "disk failure"):
                    result = consumer.fetch_snapshot("https://example.invalid", cache)
        self.assertEqual(result.data_version, VERSION)
        self.assertEqual((cache / "current").read_text(), VERSION + "\n")
        self.assertEqual(list(cache.glob(".current-*")), [])
        self.assertEqual(list((cache / "snapshots").glob(".download-*")), [])

    def test_first_cache_publication_failure_is_not_successful_fallback(self):
        cache = self.root / "cache"
        with mock.patch.object(consumer.urllib.request, "urlopen",
                               side_effect=download_from(self.files)):
            with mock.patch.object(consumer.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaisesRegex(OSError, "disk failure"):
                    consumer.fetch_snapshot("https://example.invalid", cache, VERSION)
        self.assertFalse((cache / "current").exists())
        self.assertEqual(list(cache.glob(".current-*")), [])
        self.assertEqual(list((cache / "snapshots").glob(".download-*")), [])

    def test_cache_pointer_path_traversal_and_invalid_configuration(self):
        cache = self.seed_cache()
        (cache / "current").write_text("../../outside\n")
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=OSError("offline")):
            with self.assertWarnsRegex(RuntimeWarning, "Cached snapshot is unusable"), self.assertRaisesRegex(OSError, "offline"):
                consumer.fetch_snapshot("https://example.invalid", cache)
        for kwargs in (
            {"url": "file:///private"}, {"url": "https://example.invalid?query=yes"},
            {"url": "https://example.invalid#fragment"}, {"url": "https://example.invalid", "timeout": 0},
            {"url": "https://example.invalid", "expected_data_version": "../version"},
        ):
            with self.subTest(kwargs=kwargs), mock.patch.object(
                    consumer.urllib.request, "urlopen") as opened, self.assertRaises(consumer.SnapshotError):
                consumer.fetch_snapshot(cache=cache, **kwargs)
            opened.assert_not_called()

    def test_plaintext_http_warning_but_localhost_is_supported(self):
        for hostname in ("localhost:8000", "127.0.0.1:8000", "[::1]:8000"):
            with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(self.files)):
                with warnings.catch_warnings(record=True) as caught:
                    consumer.fetch_snapshot("http://" + hostname)
                self.assertFalse(caught)
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(self.files)):
            with self.assertWarnsRegex(RuntimeWarning, "plaintext"):
                consumer.fetch_snapshot("http://example.invalid")

    def test_cli_json_metadata_provenance_and_friendly_failures(self):
        write_bundle(self.root, self.files)
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            status = consumer.main(["--snapshot", str(self.root), "--version", VERSION,
                                    "--mic", "XNAS", "--provider", "yahoo", "--active-only", "TEST"])
        self.assertEqual(status, 0)
        self.assertEqual(stderr.getvalue(), "")
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["instrument"]["id"], "ins-example")
        self.assertNotIn("primary_theme", result)
        self.assertEqual(result["tags"], vocabulary()["tags"])
        self.assertEqual(result["snapshot"]["data_version"], VERSION)
        self.assertEqual(result["snapshot"]["source_commit"], "c" * 40)
        self.assertFalse(result["snapshot"]["used_cache"])
        for extra, symbol in (([], "MISSING"), (["--version", NEXT_VERSION], "TEST")):
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(consumer.main(["--snapshot", str(self.root)] + extra + [symbol]), 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertIn("error:", stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())
        write_bundle(self.root, bundle([record(), record("ins-other", "TEST", "XNYS")]))
        stderr = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(io.StringIO()):
            self.assertEqual(consumer.main(["--snapshot", str(self.root), "TEST"]), 1)
        self.assertIn("Ambiguous symbol", stderr.getvalue())

    def test_cli_url_offline_provenance(self):
        cache = self.seed_cache()
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=OSError("offline")):
            with self.assertWarns(RuntimeWarning), redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(consumer.main([
                    "--url", "https://example.invalid", "--cache", str(cache), "TEST"]), 0)
        result = json.loads(stdout.getvalue())
        self.assertTrue(result["snapshot"]["used_cache"])
        self.assertIn("offline", result["snapshot"]["warning"])

    def seed_cache(self):
        cache = self.root / "cache"
        with mock.patch.object(consumer.urllib.request, "urlopen", side_effect=download_from(self.files)):
            consumer.fetch_snapshot("https://example.invalid", cache)
        return cache


if __name__ == "__main__":
    unittest.main()
