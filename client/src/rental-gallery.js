'use strict';

// The local catalog is the first implementation of the future gallery contract.
// No match is safer than making up a missing requirement or choosing an unrelated image.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROPERTIES = 2000;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, label, { optional = false, max = 500 } = {}) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) {
    throw new Error(`${label}应为${optional ? '' : '非空'}文本，且不超过 ${max} 个字符`);
  }
  return value.trim();
}

function strings(value, label, { optional = true, max = 40 } = {}) {
  if (optional && (value === undefined || value === null)) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}应为不超过 ${max} 项的文本列表`);
  return [...new Set(value.map((item) => cleanString(item, label)))];
}

function number(value, label, { optional = false, integer = false, min = 0, max = 10000000 } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}应为 ${min} 至 ${max} 之间的${integer ? '整数' : '数字'}`);
  }
  return value;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateCatalog(catalog) {
  if (!object(catalog) || catalog.version !== 1 || !Array.isArray(catalog.properties)) {
    throw new Error('图库格式应为 {version: 1, properties: [...]}');
  }
  if (catalog.properties.length > MAX_PROPERTIES) throw new Error(`本地图库最多保存 ${MAX_PROPERTIES} 套房源`);
  const ids = new Set();
  const properties = catalog.properties.map((entry, index) => {
    const prefix = `第 ${index + 1} 套房源`;
    if (!object(entry)) throw new Error(`${prefix}格式不正确`);
    const id = cleanString(entry.id, `${prefix} ID`, { max: 100 });
    if (ids.has(id)) throw new Error(`房源 ID 重复：${id}`);
    ids.add(id);
    if (!['entire', 'shared'].includes(entry.rentalType)) throw new Error(`${prefix}租赁方式只能是 entire（整租）或 shared（合租）`);
    if (entry.purpose !== 'residential') throw new Error(`${prefix}用途只能是 residential（居住）`);
    if (typeof entry.available !== 'boolean') throw new Error(`${prefix} available 应为 true 或 false`);
    const minLeaseMonths = number(entry.minLeaseMonths, `${prefix}最短租期`, { integer: true, min: 1, max: 1200 });
    const maxLeaseMonths = number(entry.maxLeaseMonths, `${prefix}最长租期`, { optional: true, integer: true, min: 1, max: 1200 });
    if (maxLeaseMonths !== null && maxLeaseMonths < minLeaseMonths) throw new Error(`${prefix}最长租期不能小于最短租期`);
    const availableFrom = cleanString(entry.availableFrom, `${prefix}可入住日期`, { optional: true, max: 10 });
    if (availableFrom && !validDate(availableFrom)) throw new Error(`${prefix}可入住日期应为真实的 YYYY-MM-DD 日期`);
    return {
      id,
      title: cleanString(entry.title, `${prefix}名称`, { max: 160 }),
      city: cleanString(entry.city, `${prefix}城市`, { max: 80 }),
      district: cleanString(entry.district, `${prefix}区域`, { optional: true, max: 80 }),
      locations: strings(entry.locations, `${prefix}地点/别名`),
      rent: number(entry.rent, `${prefix}月租`, { min: 0.01 }),
      bedrooms: number(entry.bedrooms, `${prefix}卧室数`, { integer: true, min: 0, max: 50 }),
      rentalType: entry.rentalType,
      minLeaseMonths,
      ...(maxLeaseMonths === null ? {} : { maxLeaseMonths }),
      purpose: 'residential',
      available: entry.available,
      ...(availableFrom ? { availableFrom } : {}),
      features: strings(entry.features, `${prefix}配套/条件`),
      images: strings(entry.images, `${prefix}图片路径`, { max: 20 }),
    };
  });
  return { version: 1, properties };
}

function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function region(value, kind) {
  const normalized = normalize(value);
  return kind === 'city' ? normalized.replace(/市$/, '') : normalized.replace(/(?:区|县)$/, '');
}

const FEATURE_ALIASES = new Map([
  ['有电梯', '电梯'], ['电梯房', '电梯'],
  ['允许养宠', '可养宠'], ['允许养宠物', '可养宠'], ['可养宠物', '可养宠'], ['宠物友好', '可养宠'],
  ['独立卫生间', '独卫'], ['独立卫浴', '独卫'],
  ['独立厨房', '独厨'], ['可做饭', '能做饭'],
]);

function feature(value) {
  const normalized = normalize(value).replace(/^(?:必须|要求|需要|希望)/, '');
  return FEATURE_ALIASES.get(normalized) || normalized;
}

function normalizeDemand(raw) {
  if (!object(raw)) throw new Error('尚未提取到明确租房需求');
  const demand = {
    city: cleanString(raw.city, '需求城市', { optional: true, max: 80 }),
    district: cleanString(raw.district, '需求区域', { optional: true, max: 80 }),
    locations: strings(raw.locations, '需求地点'),
    budgetMin: number(raw.budgetMin, '最低月租', { optional: true }),
    budgetMax: number(raw.budgetMax, '最高月租', { optional: true }),
    bedrooms: raw.bedrooms === undefined || raw.bedrooms === null ? [] : raw.bedrooms,
    rentalType: raw.rentalType || 'unknown',
    leaseMonthsMin: number(raw.leaseMonthsMin, '最短需求租期', { optional: true, integer: true, min: 1, max: 1200 }),
    leaseMonthsMax: number(raw.leaseMonthsMax, '最长需求租期', { optional: true, integer: true, min: 1, max: 1200 }),
    purpose: raw.purpose || 'unknown',
    moveIn: cleanString(raw.moveIn, '入住时间', { optional: true, max: 100 }),
    requirements: strings(raw.requirements, '其他明确要求'),
  };
  if (!Array.isArray(demand.bedrooms) || demand.bedrooms.length > 20) throw new Error('需求户型应为卧室数列表');
  demand.bedrooms = [...new Set(demand.bedrooms.map((value) => number(value, '需求卧室数', { integer: true, min: 0, max: 50 })))];
  if (!['entire', 'shared', 'unknown'].includes(demand.rentalType)) throw new Error('需求租赁方式无法识别');
  if (!['residential', 'commercial', 'unknown'].includes(demand.purpose)) throw new Error('需求用途无法识别');
  if (demand.budgetMin !== null && demand.budgetMax !== null && demand.budgetMin > demand.budgetMax) throw new Error('需求预算上下限矛盾，需要确认');
  if (demand.leaseMonthsMin !== null && demand.leaseMonthsMax !== null && demand.leaseMonthsMin > demand.leaseMonthsMax) throw new Error('需求租期上下限矛盾，需要确认');
  return demand;
}

function geographicMatch(property, demand) {
  if (demand.city && region(demand.city, 'city') !== region(property.city, 'city')) return false;
  if (demand.district && region(demand.district, 'district') !== region(property.district, 'district')) return false;
  const propertyLocations = new Set(property.locations.map(normalize));
  return !demand.locations.length || demand.locations.some((location) => propertyLocations.has(normalize(location)));
}

function matchProperty(property, demand) {
  const reasons = [];
  if (!property.available) return { reason: '房源当前不可租' };
  if (demand.city && region(demand.city, 'city') !== region(property.city, 'city')) return { reason: '城市不符' };
  if (demand.district && region(demand.district, 'district') !== region(property.district, 'district')) return { reason: '区域不符' };
  if (demand.city) reasons.push(`城市符合：${property.city}`);
  if (demand.district) reasons.push(`区域符合：${property.district}`);
  const propertyLocations = new Set(property.locations.map(normalize));
  const locationMatches = demand.locations.filter((location) => propertyLocations.has(normalize(location)));
  if (demand.locations.length && !locationMatches.length) return { reason: '明确地点不符（仅接受图库中登记的地点或别名）' };
  if (locationMatches.length) reasons.push(`地点符合：${locationMatches.join('、')}`);
  if ((demand.budgetMin !== null && property.rent < demand.budgetMin) || (demand.budgetMax !== null && property.rent > demand.budgetMax)) return { reason: '月租超出明确预算范围' };
  if (demand.budgetMin !== null || demand.budgetMax !== null) reasons.push(`月租 ${property.rent} 元，符合明确预算`);
  if (demand.bedrooms.length && !demand.bedrooms.includes(property.bedrooms)) return { reason: '卧室数不符' };
  if (demand.bedrooms.length) reasons.push(`户型符合：${property.bedrooms} 室`);
  if (demand.rentalType !== 'unknown' && demand.rentalType !== property.rentalType) return { reason: '整租/合租要求不符' };
  if (demand.rentalType !== 'unknown') reasons.push(`租赁方式符合：${property.rentalType === 'entire' ? '整租' : '合租'}`);
  const leaseLower = Math.max(4, demand.leaseMonthsMin || 4, property.minLeaseMonths);
  const leaseUpper = Math.min(demand.leaseMonthsMax || Infinity, property.maxLeaseMonths || Infinity);
  if (leaseLower > leaseUpper) return { reason: '租期不符或房源仅支持短租' };
  if (demand.leaseMonthsMin !== null || demand.leaseMonthsMax !== null) reasons.push(`租期有符合要求的长租方案（至少 ${leaseLower} 个月）`);
  if (demand.moveIn && property.availableFrom) {
    if (!validDate(demand.moveIn)) return { reason: '入住时间不是明确日期，暂不能核对房源可入住时间' };
    if (property.availableFrom > demand.moveIn) return { reason: '房源可入住时间晚于需求' };
    reasons.push(`可入住日期符合：${property.availableFrom}`);
  }
  const knownFeatures = new Set(property.features.map(feature));
  const unverified = demand.requirements.filter((requirement) => !knownFeatures.has(feature(requirement)));
  if (unverified.length) return { reason: `图库无法证明这些明确要求：${unverified.join('、')}` };
  if (demand.requirements.length) reasons.push(`配套要求符合：${demand.requirements.join('、')}`);
  return { matched: true, reasons, locationMatches: locationMatches.length };
}

function imageSignature(buffer) {
  if (buffer.length < 12) return false;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') return true;
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return true;
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return true;
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return true;
  if (buffer.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(buffer.toString('ascii', 8, 12))) return true;
  return false;
}

async function firstValidImage(property, directory) {
  for (const image of property.images) {
    // Never turn a future HTTP image URL into a download without an API contract.
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(image)) continue;
    const imagePath = path.resolve(directory, image);
    let handle;
    try {
      const target = await fs.stat(imagePath);
      if (!target.isFile() || target.size < 12 || target.size > MAX_IMAGE_BYTES) continue;
      handle = await fs.open(imagePath, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size < 12 || info.size > MAX_IMAGE_BYTES) continue;
      const header = Buffer.alloc(Math.min(64, info.size));
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (imageSignature(header.subarray(0, bytesRead))) return imagePath;
    } catch {
      // Missing/unreadable pictures belong to this candidate, not the whole task.
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
  return null;
}

async function selectGalleryMatch({ demand: rawDemand, catalogPath } = {}) {
  const result = (status, reason, details = {}) => ({ status, reason, source: 'local', ...details });
  let demand;
  try {
    demand = normalizeDemand(rawDemand);
  } catch (error) {
    return result('needs_more_info', error.message);
  }
  if (demand.purpose === 'commercial') return result('no_match', '明确为商铺/商业租赁需求，不属于居住长租受众');
  if (demand.leaseMonthsMax !== null && demand.leaseMonthsMax <= 3) return result('no_match', '明确为 1–3 个月短租，不属于长租受众');
  if (!demand.city && !demand.district && !demand.locations.length) return result('needs_more_info', '尚未提取到明确求租地点，不能替用户猜测地区或发送房源图片');
  if (typeof catalogPath !== 'string' || !catalogPath.trim()) return result('not_configured', '尚未配置本地房源图库');
  let catalog;
  try {
    const info = await fs.stat(catalogPath);
    if (!info.isFile() || info.size > MAX_CATALOG_BYTES) return result('failed', '本地图库应为不超过 2 MB 的 JSON 文件');
    catalog = validateCatalog(JSON.parse(await fs.readFile(catalogPath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return result('not_configured', '本地房源图库尚未创建');
    return result('failed', error instanceof SyntaxError ? '本地图库 JSON 格式错误' : `读取本地图库失败：${error.message}`);
  }
  if (!catalog.properties.length) return result('no_match', '本地图库暂无房源，请先添加真实房源及对应图片');
  // Geography must not be inferred from a cheap price or matching bedroom count.
  // Detect a same-name place across cities before applying those other filters.
  if (!demand.city && new Set(catalog.properties.filter((property) => geographicMatch(property, demand)).map((property) => region(property.city, 'city'))).size > 1) {
    return result('needs_more_info', '同名地区/地点匹配到多个城市，需要先确认求租城市');
  }
  const candidates = [];
  const rejected = new Map();
  for (const property of catalog.properties) {
    const matching = matchProperty(property, demand);
    if (matching.matched) candidates.push({ property, ...matching });
    else rejected.set(matching.reason, (rejected.get(matching.reason) || 0) + 1);
  }
  // All explicit conditions already passed. Prefer more exact location aliases,
  // then a lower price and stable ID; unknown budgets never become invented caps.
  candidates.sort((a, b) => b.locationMatches - a.locationMatches || a.property.rent - b.property.rent || a.property.id.localeCompare(b.property.id, 'en'));
  for (const candidate of candidates) {
    const imagePath = await firstValidImage(candidate.property, path.dirname(path.resolve(catalogPath)));
    if (imagePath) {
      return result('matched', '已按本篇笔记的明确需求匹配真实图库房源', {
        property: candidate.property,
        imagePath,
        matchReasons: candidate.reasons,
      });
    }
  }
  if (candidates.length) return result('no_match', `有 ${candidates.length} 套房源条件匹配，但没有可读取的有效本地图片（上限 20 MB）；不发送替代图片`);
  return result('no_match', `图库没有满足本篇全部明确需求的房源：${[...rejected].map(([reason, count]) => `${reason} ${count} 套`).join('；')}`);
}

module.exports = { validateCatalog, selectGalleryMatch, normalizeDemand, MAX_CATALOG_BYTES, MAX_IMAGE_BYTES };
