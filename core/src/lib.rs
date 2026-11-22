use regress::Regex as JsRegex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::LazyLock;
use wasm_bindgen::prelude::*;

const KERNEL_UNIT: &str = "kernel";
const OBJECT_DATA: u8 = 1;
const OBJECT_ENTRY: u8 = 3;
const OBJECT_ENTRY_ARRAY: u8 = 6;
const COMPRESSED_XZ: u8 = 1;
const COMPRESSED_LZ4: u8 = 2;
const COMPRESSED_ZSTD: u8 = 4;
const HEADER_INCOMPATIBLE_COMPACT: u32 = 1 << 4;
const HDR_INCOMPATIBLE_FLAGS: usize = 12;
const HDR_HEADER_SIZE: usize = 88;
const HDR_ENTRY_ARRAY_OFFSET: usize = 176;
const HDR_ENTRY_ARRAY_OFFSET_LEGACY: usize = 168;
const DATA_PAYLOAD: usize = 64;
const DATA_PAYLOAD_LEGACY: usize = 56;
const ENTRY_REALTIME: usize = 24;
const ENTRY_ITEMS: usize = 64;
const ENTRY_ITEM_SIZE: usize = 16;
const EARRAY_NEXT: usize = 16;
const EARRAY_ITEMS: usize = 24;
const MAX_DECOMPRESSED_OBJECT: usize = 256 * 1024 * 1024;

static ISO_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)\s+(\S+)\s+(.*)$").unwrap()
});
static SYSLOG_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$").unwrap()
});
static SYSLOG_TIME_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})").unwrap()
});
static UNIT_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^([A-Za-z0-9_.@-]+?)(?:\[(\d+)\])?:\s+(.*)$").unwrap());

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    use wasm_bindgen::JsCast;
    thread_local! {
        static PERFORMANCE: Option<web_sys::Performance> = js_sys::global()
            .dyn_into::<web_sys::WorkerGlobalScope>()
            .ok()
            .and_then(|scope| scope.performance());
    }
    PERFORMANCE.with(|p| p.as_ref().map_or_else(js_sys::Date::now, |p| p.now()))
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FieldValues {
    pub name: String,
    pub values: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: u32,
    pub ts: Option<f64>,
    pub host: String,
    pub unit: String,
    pub pid: String,
    pub priority: Option<u8>,
    pub message: String,
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<FieldValues>>,
}

#[derive(Clone, Debug)]
struct Entry {
    ts: Option<f64>,
    host: String,
    unit: String,
    pid: String,
    priority: Option<u8>,
    message: String,
    raw: String,
    fields: Option<Vec<FieldValues>>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    #[serde(skip)]
    enabled: bool,
    pub decompression_ms: f64,
    pub object_traversal_ms: f64,
    pub string_conversion_ms: f64,
    pub record_construction_ms: f64,
    pub json_parse_ms: f64,
    pub text_parse_ms: f64,
    pub sort_index_ms: f64,
    pub input_bytes: u64,
}

impl Metrics {
    #[inline]
    fn start(&self) -> f64 {
        if self.enabled { now_ms() } else { 0.0 }
    }

    #[inline]
    fn elapsed(&self, started: f64) -> f64 {
        if self.enabled { now_ms() - started } else { 0.0 }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub per_unit: BTreeMap<String, usize>,
    pub per_prio: BTreeMap<String, usize>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    pub id: String,
    pub index: usize,
    pub count: usize,
    pub first_ts: Option<f64>,
    pub last_ts: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub records: usize,
    pub units: Vec<String>,
    pub has_kernel: bool,
    pub stats: Stats,
    pub boots: Vec<BootInfo>,
    pub capped: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    pub since: Option<f64>,
    pub until: Option<f64>,
    #[serde(default)]
    pub units: Vec<String>,
    pub kernel: bool,
    #[serde(default)]
    pub pattern: String,
    pub ignore_case: bool,
    pub max_priority: Option<u8>,
    pub boot_id: Option<String>,
}

#[derive(Default)]
struct BootAccumulator {
    count: usize,
    first: Option<f64>,
    last: Option<f64>,
}

#[wasm_bindgen]
pub struct JournalEngine {
    entries: Vec<Entry>,
    metrics: Metrics,
    max_records: usize,
    capped: bool,
}

fn priority_name(priority: Option<u8>) -> &'static str {
    match priority {
        Some(0) => "emerg",
        Some(1) => "alert",
        Some(2) => "crit",
        Some(3) => "err",
        Some(4) => "warning",
        Some(5) => "notice",
        Some(6) => "info",
        Some(7) => "debug",
        _ => "unknown",
    }
}

fn first_field<'a>(fields: &'a [FieldValues], name: &str) -> &'a str {
    fields
        .iter()
        .find(|field| field.name == name)
        .and_then(|field| field.values.first())
        .map(String::as_str)
        .unwrap_or("")
}

fn push_field(fields: &mut Vec<FieldValues>, name: String, value: String) {
    if let Some(field) = fields.iter_mut().find(|field| field.name == name) {
        field.values.push(value);
    } else {
        fields.push(FieldValues {
            name,
            values: vec![value],
        });
    }
}

fn parse_priority(value: &str) -> Option<u8> {
    value.parse::<u8>().ok().filter(|p| *p <= 7)
}

fn entry_from_fields(realtime_usec: f64, fields: Vec<FieldValues>) -> Entry {
    let transport = first_field(&fields, "_TRANSPORT");
    let mut unit = first_field(&fields, "_SYSTEMD_UNIT").to_string();
    if unit.is_empty() {
        unit = first_field(&fields, "UNIT").to_string();
    }
    if transport == KERNEL_UNIT {
        unit = KERNEL_UNIT.to_string();
    }
    let message = fields
        .iter()
        .find(|field| field.name == "MESSAGE")
        .map(|field| field.values.join("\n"))
        .unwrap_or_default();
    Entry {
        ts: Some(realtime_usec / 1000.0),
        host: first_field(&fields, "_HOSTNAME").to_string(),
        unit,
        pid: first_field(&fields, "_PID").to_string(),
        priority: parse_priority(first_field(&fields, "PRIORITY")),
        raw: message.clone(),
        message,
        fields: Some(fields),
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Array(values) => {
            let bytes: Vec<u8> = values
                .iter()
                .filter_map(|v| v.as_u64())
                .map(|v| v as u8)
                .collect();
            String::from_utf8_lossy(&bytes).into_owned()
        }
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn entry_from_json(object: &serde_json::Map<String, Value>) -> Option<Entry> {
    let ts = object
        .get("__REALTIME_TIMESTAMP")
        .and_then(Value::as_str)
        .filter(|value| value.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value / 1000.0);
    let message = object.get("MESSAGE").map(js_string).unwrap_or_default();
    let transport = object.get("_TRANSPORT").map(js_string).unwrap_or_default();
    let mut unit = object
        .get("_SYSTEMD_UNIT")
        .map(js_string)
        .unwrap_or_default();
    if unit.is_empty() {
        unit = object.get("UNIT").map(js_string).unwrap_or_default();
    }
    if transport == KERNEL_UNIT {
        unit = KERNEL_UNIT.to_string();
    }
    let priority = object
        .get("PRIORITY")
        .filter(|value| !value.is_null())
        .map(js_string)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.fract() == 0.0 && (0.0..=7.0).contains(value))
        .map(|value| value as u8);
    let mut fields = Vec::new();
    for (key, value) in object {
        if key.starts_with("__") {
            continue;
        }
        push_field(&mut fields, key.clone(), js_string(value));
    }
    Some(Entry {
        ts,
        host: object.get("_HOSTNAME").map(js_string).unwrap_or_default(),
        unit,
        pid: object.get("_PID").map(js_string).unwrap_or_default(),
        priority,
        raw: message.clone(),
        message,
        fields: Some(fields),
    })
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

#[cfg(target_arch = "wasm32")]
fn local_timestamp(utc_ms: f64) -> f64 {
    let first = js_sys::Date::new(&JsValue::from_f64(utc_ms)).get_timezone_offset() * 60_000.0;
    let approximate = utc_ms - first;
    let second =
        js_sys::Date::new(&JsValue::from_f64(approximate)).get_timezone_offset() * 60_000.0;
    utc_ms - second
}

#[cfg(not(target_arch = "wasm32"))]
fn local_timestamp(utc_ms: f64) -> f64 {
    utc_ms
}

fn parse_iso_timestamp(text: &str) -> Option<f64> {
    if text.len() < 19 {
        return None;
    }
    let year = text.get(0..4)?.parse::<i64>().ok()?;
    let month = text.get(5..7)?.parse::<i64>().ok()?;
    let day = text.get(8..10)?.parse::<i64>().ok()?;
    let hour = text.get(11..13)?.parse::<i64>().ok()?;
    let minute = text.get(14..16)?.parse::<i64>().ok()?;
    let second = text.get(17..19)?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut rest = text.get(19..)?;
    let mut millis = 0.0;
    if rest.starts_with('.') || rest.starts_with(',') {
        rest = &rest[1..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let fraction = &rest[..digits];
        let mut padded = fraction.chars().take(3).collect::<String>();
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded.parse::<f64>().ok()?;
        rest = &rest[digits..];
    }
    let base = days_from_civil(year, month, day) as f64 * 86_400_000.0
        + (hour * 3600 + minute * 60 + second) as f64 * 1000.0
        + millis;
    if rest.is_empty() {
        Some(local_timestamp(base))
    } else if rest == "Z" {
        Some(base)
    } else {
        let sign = match rest.as_bytes().first() {
            Some(b'+') => 1.0,
            Some(b'-') => -1.0,
            _ => return None,
        };
        let zone = &rest[1..].replace(':', "");
        if zone.len() != 4 {
            return None;
        }
        let zone_hour = zone[..2].parse::<i64>().ok()?;
        let zone_minute = zone[2..].parse::<i64>().ok()?;
        if zone_hour > 23 || zone_minute > 59 {
            return None;
        }
        Some(base - sign * (zone_hour * 60 + zone_minute) as f64 * 60_000.0)
    }
}

fn syslog_month(month: &str) -> Option<i64> {
    [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|candidate| *candidate == month)
    .map(|index| index as i64 + 1)
}

fn parse_syslog_timestamp(text: &str, year: i64) -> Option<f64> {
    let captures = SYSLOG_TIME_RE.captures(text)?;
    let month = syslog_month(captures.get(1)?.as_str())?;
    let day = captures.get(2)?.as_str().parse::<i64>().ok()?;
    let hour = captures.get(3)?.as_str().parse::<i64>().ok()?;
    let minute = captures.get(4)?.as_str().parse::<i64>().ok()?;
    let second = captures.get(5)?.as_str().parse::<i64>().ok()?;
    let utc = days_from_civil(year, month, day) as f64 * 86_400_000.0
        + (hour * 3600 + minute * 60 + second) as f64 * 1000.0;
    Some(local_timestamp(utc))
}

fn entry_from_text(line: &str, default_year: i64) -> Entry {
    let mut ts = None;
    let mut host = String::new();
    let mut rest = line;
    if let Some(captures) = ISO_RE.captures(line) {
        ts = captures
            .get(1)
            .and_then(|m| parse_iso_timestamp(m.as_str()));
        host = captures
            .get(2)
            .map(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        rest = captures.get(3).map(|m| m.as_str()).unwrap_or("");
    } else if let Some(captures) = SYSLOG_RE.captures(line) {
        ts = captures
            .get(1)
            .and_then(|m| parse_syslog_timestamp(m.as_str(), default_year));
        host = captures
            .get(2)
            .map(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        rest = captures.get(3).map(|m| m.as_str()).unwrap_or("");
    }
    let mut unit = String::new();
    let mut pid = String::new();
    let mut message = rest.to_string();
    if let Some(captures) = UNIT_RE.captures(rest) {
        unit = captures
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        pid = captures
            .get(2)
            .map(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        message = captures
            .get(3)
            .map(|m| m.as_str())
            .unwrap_or("")
            .to_string();
    }
    Entry {
        ts,
        host,
        unit,
        pid,
        priority: None,
        message,
        raw: line.to_string(),
        fields: None,
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    fn u8(&self, offset: usize) -> Option<u8> {
        self.bytes.get(offset).copied()
    }

    fn u32(&self, offset: usize) -> Option<u32> {
        let raw = self.bytes.get(offset..offset.checked_add(4)?)?;
        Some(u32::from_le_bytes(raw.try_into().ok()?))
    }

    fn u64(&self, offset: usize) -> Option<u64> {
        let raw = self.bytes.get(offset..offset.checked_add(8)?)?;
        Some(u64::from_le_bytes(raw.try_into().ok()?))
    }

    fn usize(&self, offset: usize) -> Option<usize> {
        usize::try_from(self.u64(offset)?).ok()
    }
}

fn decompress_payload(flags: u8, data: &[u8]) -> Result<Cow<'_, [u8]>, String> {
    if flags & COMPRESSED_LZ4 != 0 {
        if data.len() <= 8 {
            return Err("Truncated LZ4 payload".to_string());
        }
        let expected = u64::from_le_bytes(data[..8].try_into().map_err(|_| "Truncated LZ4 size")?);
        let expected = usize::try_from(expected).map_err(|_| "LZ4 payload is too large")?;
        if expected > MAX_DECOMPRESSED_OBJECT {
            return Err("LZ4 payload exceeds the 256 MiB safety limit".to_string());
        }
        let output = lz4_flex::block::decompress(&data[8..], expected)
            .map_err(|error| format!("Invalid LZ4 payload: {error}"))?;
        if output.len() != expected {
            return Err(format!(
                "LZ4 payload size mismatch (got {}, expected {expected})",
                output.len()
            ));
        }
        return Ok(Cow::Owned(output));
    }
    if flags & COMPRESSED_ZSTD != 0 {
        let mut decoder = ruzstd::decoding::StreamingDecoder::new(data)
            .map_err(|error| format!("Invalid ZSTD payload: {error:?}"))?;
        let mut output = Vec::new();
        decoder
            .by_ref()
            .take((MAX_DECOMPRESSED_OBJECT + 1) as u64)
            .read_to_end(&mut output)
            .map_err(|error| format!("Invalid ZSTD payload: {error}"))?;
        if output.len() > MAX_DECOMPRESSED_OBJECT {
            return Err("ZSTD payload exceeds the 256 MiB safety limit".to_string());
        }
        return Ok(Cow::Owned(output));
    }
    if flags & COMPRESSED_XZ != 0 {
        let mut input = std::io::Cursor::new(data);
        let mut output = Vec::new();
        lzma_rs::xz_decompress(&mut input, &mut output)
            .map_err(|error| format!("Invalid XZ payload: {error:?}"))?;
        if output.len() > MAX_DECOMPRESSED_OBJECT {
            return Err("XZ payload exceeds the 256 MiB safety limit".to_string());
        }
        return Ok(Cow::Owned(output));
    }
    Ok(Cow::Borrowed(data))
}

fn split_field(text: &str) -> Option<(&str, &str)> {
    let equals = text.find('=')?;
    let name = &text.as_bytes()[..equals];
    let valid = matches!(name.first(), Some(b'A'..=b'Z' | b'_'))
        && name[1..]
            .iter()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'0'..=b'9' | b'_'));
    valid.then_some((&text[..equals], &text[equals + 1..]))
}

#[allow(clippy::too_many_arguments)]
fn read_data_object(
    reader: &Reader<'_>,
    offset: usize,
    cache: &mut HashMap<usize, Option<(String, String)>>,
    metrics: &mut Metrics,
) -> Option<(String, String)> {
    if let Some(cached) = cache.get(&offset) {
        return cached.clone();
    }
    let mut result = None;
    if reader.u8(offset) == Some(OBJECT_DATA) {
        let flags = reader.u8(offset + 1).unwrap_or(0);
        if let Some(size) = reader.usize(offset + 8) {
            for payload_offset in [DATA_PAYLOAD, DATA_PAYLOAD_LEGACY] {
                if size <= payload_offset
                    || offset
                        .checked_add(size)
                        .is_none_or(|end| end > reader.bytes.len())
                {
                    continue;
                }
                let start = offset + payload_offset;
                let raw = &reader.bytes[start..offset + size];
                let started = metrics.start();
                let payload = match decompress_payload(flags, raw) {
                    Ok(payload) => payload,
                    Err(_) => {
                        metrics.decompression_ms += metrics.elapsed(started);
                        cache.insert(offset, None);
                        return None;
                    }
                };
                metrics.decompression_ms += metrics.elapsed(started);
                let started = metrics.start();
                let text = String::from_utf8_lossy(&payload);
                metrics.string_conversion_ms += metrics.elapsed(started);
                if let Some((name, value)) = split_field(&text) {
                    result = Some((name.to_string(), value.to_string()));
                    break;
                }
            }
        }
    }
    cache.insert(offset, result.clone());
    result
}

fn parse_journal_bytes(
    bytes: &[u8],
    metrics: &mut Metrics,
) -> Result<Vec<(f64, Vec<FieldValues>)>, String> {
    if bytes.get(..8) != Some(b"LPKSHHRH") {
        return Err("Not a journal file (bad signature)".to_string());
    }
    let reader = Reader::new(bytes);
    let incompatible = reader
        .u32(HDR_INCOMPATIBLE_FLAGS)
        .ok_or("Corrupt journal header")?;
    if incompatible & !0b11111 != 0 {
        return Err(format!(
            "Unsupported journal file (incompatible flags 0x{incompatible:x})"
        ));
    }
    if incompatible & HEADER_INCOMPATIBLE_COMPACT != 0 {
        return Err("Journal file uses compact mode (not supported yet). Export it on the target: journalctl --directory <path> -o json > logs.json".to_string());
    }
    let header_size = reader
        .usize(HDR_HEADER_SIZE)
        .ok_or("Corrupt journal header")?;
    if header_size < 208 || header_size > bytes.len() {
        return Err("Corrupt journal header".to_string());
    }
    let array_offset_ok = |offset: usize| {
        offset > 0
            && offset.checked_add(24).is_some_and(|end| end <= bytes.len())
            && reader.u8(offset) == Some(OBJECT_ENTRY_ARRAY)
    };
    let mut array_offset = reader.usize(HDR_ENTRY_ARRAY_OFFSET).unwrap_or(0);
    if !array_offset_ok(array_offset) {
        array_offset = reader.usize(HDR_ENTRY_ARRAY_OFFSET_LEGACY).unwrap_or(0);
    }
    if !array_offset_ok(array_offset) {
        return Err("No entry array found in journal file".to_string());
    }

    let parse_started = metrics.start();
    let decompression_before = metrics.decompression_ms;
    let strings_before = metrics.string_conversion_ms;
    let mut cache = HashMap::new();
    let mut entries = Vec::new();
    let mut array_guard = 0;
    while array_offset != 0 && array_guard < 100_000 {
        array_guard += 1;
        if reader.u8(array_offset) != Some(OBJECT_ENTRY_ARRAY) {
            break;
        }
        let Some(size) = reader.usize(array_offset + 8) else {
            break;
        };
        if size < EARRAY_ITEMS
            || array_offset
                .checked_add(size)
                .is_none_or(|end| end > bytes.len())
        {
            break;
        }
        let count = (size - EARRAY_ITEMS) / 8;
        for index in 0..count {
            let item_offset = array_offset + EARRAY_ITEMS + index * 8;
            let Some(entry_offset) = reader.usize(item_offset) else {
                continue;
            };
            if entry_offset == 0 || reader.u8(entry_offset) != Some(OBJECT_ENTRY) {
                continue;
            }
            let Some(entry_size) = reader.usize(entry_offset + 8) else {
                continue;
            };
            if entry_size < ENTRY_ITEMS
                || entry_offset
                    .checked_add(entry_size)
                    .is_none_or(|end| end > bytes.len())
            {
                continue;
            }
            let Some(realtime) = reader.u64(entry_offset + ENTRY_REALTIME) else {
                continue;
            };
            let item_count = (entry_size - ENTRY_ITEMS) / ENTRY_ITEM_SIZE;
            let mut fields = Vec::new();
            for item in 0..item_count {
                let offset_position = entry_offset + ENTRY_ITEMS + item * ENTRY_ITEM_SIZE;
                let Some(data_offset) = reader.usize(offset_position) else {
                    continue;
                };
                if let Some((name, value)) =
                    read_data_object(&reader, data_offset, &mut cache, metrics)
                {
                    push_field(&mut fields, name, value);
                }
            }
            entries.push((realtime as f64, fields));
        }
        array_offset = reader.usize(array_offset + EARRAY_NEXT).unwrap_or(0);
    }
    let nested = (metrics.decompression_ms - decompression_before)
        + (metrics.string_conversion_ms - strings_before);
    metrics.object_traversal_ms += (metrics.elapsed(parse_started) - nested).max(0.0);
    Ok(entries)
}

impl JournalEngine {
    fn push_entry(&mut self, entry: Entry) {
        if self.entries.len() < self.max_records {
            self.entries.push(entry);
        } else {
            self.capped = true;
        }
    }

    fn record_value(&self, id: u32, include_fields: bool) -> Option<Record> {
        let entry = self.entries.get(id as usize)?;
        Some(Record {
            id,
            ts: entry.ts,
            host: entry.host.clone(),
            unit: entry.unit.clone(),
            pid: entry.pid.clone(),
            priority: entry.priority,
            message: entry.message.clone(),
            raw: entry.raw.clone(),
            fields: if include_fields {
                entry.fields.clone()
            } else {
                None
            },
        })
    }

    fn summary_value(&self) -> Summary {
        let stats = compute_stats(self.entries.iter());
        let mut units = std::collections::BTreeSet::new();
        let mut has_kernel = false;
        let mut boots: BTreeMap<String, BootAccumulator> = BTreeMap::new();
        for entry in &self.entries {
            if entry.unit == KERNEL_UNIT {
                has_kernel = true;
            } else if !entry.unit.is_empty() {
                units.insert(entry.unit.clone());
            }
            if let Some(fields) = &entry.fields {
                let boot = first_field(fields, "_BOOT_ID");
                if !boot.is_empty() {
                    let accumulator = boots.entry(boot.to_string()).or_default();
                    accumulator.count += 1;
                    if let Some(ts) = entry.ts {
                        accumulator.first = Some(accumulator.first.map_or(ts, |old| old.min(ts)));
                        accumulator.last = Some(accumulator.last.map_or(ts, |old| old.max(ts)));
                    }
                }
            }
        }
        let mut boot_values: Vec<_> = boots.into_iter().collect();
        boot_values.sort_by(|a, b| {
            a.1.first
                .unwrap_or(0.0)
                .partial_cmp(&b.1.first.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let boots = boot_values
            .into_iter()
            .enumerate()
            .map(|(index, (id, value))| BootInfo {
                id,
                index,
                count: value.count,
                first_ts: value.first,
                last_ts: value.last,
            })
            .collect();
        Summary {
            records: self.entries.len(),
            units: units.into_iter().collect(),
            has_kernel,
            stats,
            boots,
            capped: self.capped,
        }
    }
}

fn compute_stats<'a>(entries: impl Iterator<Item = &'a Entry>) -> Stats {
    let mut stats = Stats::default();
    for entry in entries {
        let unit = if entry.unit.is_empty() {
            "(none)"
        } else {
            &entry.unit
        };
        *stats.per_unit.entry(unit.to_string()).or_default() += 1;
        *stats
            .per_prio
            .entry(priority_name(entry.priority).to_string())
            .or_default() += 1;
        if let Some(ts) = entry.ts {
            stats.min = Some(stats.min.map_or(ts, |old| old.min(ts)));
            stats.max = Some(stats.max.map_or(ts, |old| old.max(ts)));
        }
    }
    stats
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|error| JsValue::from_str(&error.to_string()))
}

enum EntryPattern {
    Literal { value: String, regex: JsRegex },
    Regex(JsRegex),
}

impl EntryPattern {
    fn matches(&self, entry: &Entry, ignore_case: bool) -> bool {
        match self {
            Self::Regex(regex) => {
                regex.find(&entry.raw).is_some()
                    || regex.find(&entry.message).is_some()
                    || regex.find(&entry.unit).is_some()
            }
            Self::Literal { value, regex } => {
                let ascii_fast_path = value.is_ascii()
                    && entry.raw.is_ascii()
                    && entry.message.is_ascii()
                    && entry.unit.is_ascii();
                if ascii_fast_path {
                    return literal_contains(&entry.raw, value, ignore_case)
                        || literal_contains(&entry.message, value, ignore_case)
                        || literal_contains(&entry.unit, value, ignore_case);
                }
                // JavaScript's non-Unicode ignore-case folding differs for a few
                // non-ASCII characters; retain the ECMAScript engine there.
                regex.find(&entry.raw).is_some()
                    || regex.find(&entry.message).is_some()
                    || regex.find(&entry.unit).is_some()
            }
        }
    }
}

fn literal_contains(haystack: &str, needle: &str, ignore_case: bool) -> bool {
    if !ignore_case {
        return haystack.contains(needle);
    }
    let needle = needle.as_bytes();
    needle.is_empty()
        || haystack
            .as_bytes()
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
}

fn is_regex_literal(pattern: &str) -> bool {
    !pattern.bytes().any(|byte| {
        matches!(byte, b'\\' | b'.' | b'^' | b'$' | b'*' | b'+' | b'?' | b'(' | b')' | b'[' | b']' | b'{' | b'}' | b'|')
    })
}

#[wasm_bindgen]
impl JournalEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(max_records: u32) -> Self {
        Self {
            entries: Vec::new(),
            metrics: Metrics::default(),
            max_records: if max_records == 0 {
                usize::MAX
            } else {
                max_records as usize
            },
            capped: false,
        }
    }

    pub fn reset(&mut self) {
        self.entries.clear();
        let enabled = self.metrics.enabled;
        self.metrics = Metrics::default();
        self.metrics.enabled = enabled;
        self.capped = false;
    }

    pub fn set_metrics_enabled(&mut self, enabled: bool) {
        self.metrics.enabled = enabled;
    }

    pub fn add_journal(&mut self, bytes: &[u8]) -> Result<u32, JsValue> {
        self.metrics.input_bytes += bytes.len() as u64;
        let parsed = parse_journal_bytes(bytes, &mut self.metrics)
            .map_err(|error| JsValue::from_str(&error))?;
        let started = self.metrics.start();
        let count = parsed.len() as u32;
        for (timestamp, fields) in parsed {
            self.push_entry(entry_from_fields(timestamp, fields));
        }
        self.metrics.record_construction_ms += self.metrics.elapsed(started);
        Ok(count)
    }

    pub fn add_json(&mut self, bytes: &[u8], default_year: i32) -> Result<u32, JsValue> {
        self.metrics.input_bytes += bytes.len() as u64;
        let started = self.metrics.start();
        let text = String::from_utf8_lossy(bytes);
        let mut count = 0;
        for line in text.split('\n') {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with('{') {
                if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(entry) = entry_from_json(&object) {
                        self.push_entry(entry);
                        count += 1;
                        continue;
                    }
                }
            }
            self.push_entry(entry_from_text(trimmed, default_year as i64));
            count += 1;
        }
        self.metrics.json_parse_ms += self.metrics.elapsed(started);
        Ok(count)
    }

    pub fn add_text(&mut self, bytes: &[u8], default_year: i32) -> u32 {
        self.metrics.input_bytes += bytes.len() as u64;
        let started = self.metrics.start();
        let text = String::from_utf8_lossy(bytes);
        let mut count = 0;
        for line in text.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            self.push_entry(entry_from_text(
                line.strip_suffix('\r').unwrap_or(line),
                default_year as i64,
            ));
            count += 1;
        }
        self.metrics.text_parse_ms += self.metrics.elapsed(started);
        count
    }

    pub fn finalize(&mut self) {
        let started = self.metrics.start();
        self.entries.sort_by(|a, b| match (a.ts, b.ts) {
            (Some(left), Some(right)) => left
                .partial_cmp(&right)
                .unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
        self.metrics.sort_index_ms += self.metrics.elapsed(started);
    }

    pub fn summary(&self) -> Result<JsValue, JsValue> {
        to_js(&self.summary_value())
    }

    pub fn metrics(&self) -> Result<JsValue, JsValue> {
        to_js(&self.metrics)
    }

    pub fn filter(&self, filters: JsValue) -> Result<JsValue, JsValue> {
        let started = now_ms();
        let spec: FilterSpec = serde_wasm_bindgen::from_value(filters)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let mut pattern_error = None;
        let pattern = if spec.pattern.is_empty() {
            None
        } else {
            match JsRegex::with_flags(&spec.pattern, if spec.ignore_case { "i" } else { "" }) {
                Ok(regex) => Some(if is_regex_literal(&spec.pattern) {
                    EntryPattern::Literal { value: spec.pattern.clone(), regex }
                } else {
                    EntryPattern::Regex(regex)
                }),
                Err(error) => {
                    pattern_error = Some(error.to_string());
                    None
                }
            }
        };
        let units: std::collections::HashSet<&str> =
            spec.units.iter().map(String::as_str).collect();
        let mut indices = Vec::new();
        for (index, entry) in self.entries.iter().enumerate() {
            if spec
                .since
                .is_some_and(|since| entry.ts.is_some_and(|ts| ts < since))
                || spec
                    .until
                    .is_some_and(|until| entry.ts.is_some_and(|ts| ts > until))
                || spec
                    .max_priority
                    .is_some_and(|max| entry.priority.is_some_and(|priority| priority > max))
            {
                continue;
            }
            if let Some(boot) = &spec.boot_id {
                let actual_boot = entry
                    .fields
                    .as_ref()
                    .map(|fields| first_field(fields, "_BOOT_ID"))
                    .unwrap_or("");
                if actual_boot != boot {
                    continue;
                }
            }
            if entry.unit == KERNEL_UNIT {
                if !spec.kernel {
                    continue;
                }
            } else if !units.is_empty() && !units.contains(entry.unit.as_str()) {
                continue;
            }
            if let Some(pattern) = &pattern {
                if !pattern.matches(entry, spec.ignore_case) {
                    continue;
                }
            }
            indices.push(index as u32);
        }
        let stats = compute_stats(
            indices
                .iter()
                .filter_map(|index| self.entries.get(*index as usize)),
        );
        let result = js_sys::Object::new();
        let array = js_sys::Uint32Array::from(indices.as_slice());
        js_sys::Reflect::set(&result, &JsValue::from_str("indices"), &array)?;
        js_sys::Reflect::set(&result, &JsValue::from_str("stats"), &to_js(&stats)?)?;
        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("patternError"),
            &pattern_error.map_or(JsValue::NULL, |error| JsValue::from_str(&error)),
        )?;
        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("filterMs"),
            &JsValue::from_f64(now_ms() - started),
        )?;
        Ok(result.into())
    }

    pub fn records(
        &self,
        indices: &js_sys::Uint32Array,
        include_fields: bool,
    ) -> Result<JsValue, JsValue> {
        let records: Vec<Record> = indices
            .to_vec()
            .into_iter()
            .filter_map(|index| self.record_value(index, include_fields))
            .collect();
        to_js(&records)
    }

    pub fn record(&self, index: u32) -> Result<JsValue, JsValue> {
        let record = self
            .record_value(index, true)
            .ok_or_else(|| JsValue::from_str("Record index is out of range"))?;
        to_js(&record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_fixture(bytes: &[u8]) -> Vec<(f64, Vec<FieldValues>)> {
        parse_journal_bytes(bytes, &mut Metrics::default()).expect("fixture should parse")
    }

    #[test]
    fn modern_compression_codecs_match_plain() {
        let plain = parse_fixture(include_bytes!("../../tests/fixtures/plain.journal"));
        for bytes in [
            include_bytes!("../../tests/fixtures/lz4.journal").as_slice(),
            include_bytes!("../../tests/fixtures/zstd.journal").as_slice(),
            include_bytes!("../../tests/fixtures/xz.journal").as_slice(),
            include_bytes!("../../tests/fixtures/keyed.journal").as_slice(),
        ] {
            let decoded = parse_fixture(bytes);
            assert_eq!(decoded.len(), 3);
            for (expected, actual) in plain.iter().zip(decoded.iter()) {
                assert_eq!(expected.0, actual.0);
                assert_eq!(
                    first_field(&expected.1, "MESSAGE"),
                    first_field(&actual.1, "MESSAGE")
                );
                assert_eq!(
                    first_field(&expected.1, "_SYSTEMD_UNIT"),
                    first_field(&actual.1, "_SYSTEMD_UNIT")
                );
            }
        }
    }

    #[test]
    fn legacy_layout_and_repeated_fields_are_preserved() {
        let parsed = parse_fixture(include_bytes!("../../tests/fixtures/legacy.journal"));
        assert_eq!(parsed.len(), 3);
        let message = parsed[0]
            .1
            .iter()
            .find(|field| field.name == "MESSAGE")
            .unwrap();
        assert_eq!(message.values, ["message 0 ok", "repeated second message"]);
    }

    #[test]
    fn malformed_truncated_and_compact_inputs_fail_cleanly() {
        for bytes in [
            include_bytes!("../../tests/fixtures/malformed.journal").as_slice(),
            include_bytes!("../../tests/fixtures/truncated.journal").as_slice(),
            include_bytes!("../../tests/fixtures/compact.journal").as_slice(),
        ] {
            assert!(parse_journal_bytes(bytes, &mut Metrics::default()).is_err());
        }
    }

    #[test]
    fn json_and_text_construct_equivalent_primary_fields() {
        let mut json = JournalEngine::new(0);
        json.add_json(br#"{"__REALTIME_TIMESTAMP":"1735689600000000","MESSAGE":"timeout","_SYSTEMD_UNIT":"net.service","PRIORITY":"4","_BOOT_ID":"abc"}"#, 2025).unwrap();
        assert_eq!(json.entries.len(), 1);
        assert_eq!(json.entries[0].message, "timeout");
        assert_eq!(json.entries[0].unit, "net.service");
        assert_eq!(json.entries[0].priority, Some(4));

        let mut text = JournalEngine::new(0);
        text.add_text(
            b"2025-01-01T00:00:00Z edge-01 net.service[42]: timeout failure\n",
            2025,
        );
        assert_eq!(text.entries.len(), 1);
        assert_eq!(text.entries[0].host, "edge-01");
        assert_eq!(text.entries[0].unit, "net.service");
        assert_eq!(text.entries[0].pid, "42");
        assert_eq!(text.entries[0].message, "timeout failure");
    }

    #[test]
    fn summary_tracks_units_boots_and_kernel_messages() {
        let mut engine = JournalEngine::new(0);
        let parsed = parse_fixture(include_bytes!("../../tests/fixtures/plain.journal"));
        for (timestamp, fields) in parsed {
            engine.push_entry(entry_from_fields(timestamp, fields));
        }
        engine.finalize();
        let summary = engine.summary_value();
        assert_eq!(summary.records, 3);
        assert_eq!(
            summary.units,
            ["init.service", "net.service", "sensor.service"]
        );
        assert_eq!(summary.boots.len(), 1);
        assert!(!summary.has_kernel);
    }
}
