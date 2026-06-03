const OPTION_ASSET = "Equity and Index Options";

export function parseIbkrReport(csvText) {
  const sections = collectSections(csvText);
  const accountInfo = parseAccountInfo(sections);
  const exchangeRates = parseExchangeRates(sections, accountInfo.baseCurrency);
  const dividendIncome = parseDividendIncome(sections, exchangeRates);
  const positions = applyPositionDividends(
    parseOpenPositions(sections["Open Positions"], exchangeRates),
    dividendIncome.bySymbol
  );
  const tradeSummary = analyzeTrades(sections.Trades, exchangeRates);
  const tradeDetails = parseTradeDetails(sections.Trades, exchangeRates);
  const { plSummary, closedPositions } = parsePlSummary(
    sections["Realized & Unrealized Performance Summary"],
    sections.Trades
  );
  const monthlySummary = analyzeMonthlySummary(sections, exchangeRates);
  const dailyTradeStats = analyzeDailyTrades(sections.Trades, exchangeRates);
  const tickerPL = analyzeTickerPL(closedPositions);
  const nav = parseNetAssetValue(sections["Net Asset Value"], accountInfo.baseCurrency);
  const navChange = parseNavChange(sections["Change in NAV"]);
  const navHistory = parseNavHistory(
    sections["Net Asset Value History"],
    sections["Time Weighted Return History"],
    nav.rateOfReturn
  );
  const historyReturn = latestFlowAdjustedReturn(navHistory);
  if (Number.isFinite(historyReturn)) {
    nav.rateOfReturn = historyReturn;
  }
  const assetAllocation = summarizePositions(positions, "assetCategory");
  const currencyExposure = summarizePositions(positions, "currency");
  const warnings = buildWarnings(sections, nav, positions, tradeSummary);

  return {
    accountInfo,
    baseCurrency: accountInfo.baseCurrency,
    exchangeRates,
    nav,
    navChange,
    navHistory,
    plSummary,
    dividendIncome,
    positions,
    closedPositions,
    monthlySummary,
    dailyTradeStats,
    tickerPL,
    assetAllocation,
    currencyExposure,
    tradeSummary,
    tradeDetails,
    sectionStats: Object.fromEntries(
      Object.entries(sections).map(([name, rows]) => [name, rows.length])
    ),
    warnings,
    generatedAt: new Date().toISOString()
  };
}

function collectSections(csvText) {
  const rows = splitCsvRows(csvText)
    .map(parseCsvLine)
    .filter((row) => row.some((cell) => cell.trim() !== ""));

  if (isFlexCsvRows(rows)) {
    return collectFlexSections(rows);
  }

  const blocks = [];
  let currentBlock = null;

  for (const rawColumns of rows) {
    const columns = rawColumns.map((cell, index) => {
      const clean = String(cell ?? "").trim();
      return index === 0 ? clean.replace(/^\uFEFF/, "") : clean;
    });

    if (columns.length < 2) continue;

    const sectionName = columns[0];
    const rowType = columns[1];

    if (rowType === "Header") {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = {
        section: sectionName,
        headers: columns,
        rows: []
      };
      continue;
    }

    if (rowType === "Data" && currentBlock) {
      currentBlock.rows.push(columns);
    }
  }

  if (currentBlock) blocks.push(currentBlock);

  return blocks.reduce((sections, block) => {
    if (!sections[block.section]) sections[block.section] = [];

    for (const dataRow of block.rows) {
      const row = {};
      block.headers.forEach((header, index) => {
        if (header) row[header] = (dataRow[index] ?? "").trim();
      });
      sections[block.section].push(row);
    }

    return sections;
  }, {});
}

function isFlexCsvRows(rows) {
  return rows.some((row) => cleanFlexCell(row[0]) === "BOF") &&
    rows.some((row) => cleanFlexCell(row[0]) === "BOS") &&
    rows.some((row) => cleanFlexCell(row[0]) === "HEADER") &&
    rows.some((row) => cleanFlexCell(row[0]) === "DATA");
}

function collectFlexSections(rows) {
  const rawByCode = {};
  const headersByCode = {};
  const namesByCode = {};
  const sections = {};
  let statementPeriod = "";

  for (const columns of rows) {
    const rowType = cleanFlexCell(columns[0]);
    const code = columns[1];

    if (rowType === "BOF") {
      const start = displayFlexDate(columns[4]);
      const end = displayFlexDate(columns[5]);
      statementPeriod = start && end ? `${start} - ${end}` : "";
      continue;
    }

    if (rowType === "BOS") {
      namesByCode[code] = columns[2] || code;
      continue;
    }

    if (rowType === "HEADER") {
      headersByCode[code] = columns.slice(2);
      continue;
    }

    if (rowType !== "DATA" || !headersByCode[code]) continue;

    const row = {};
    headersByCode[code].forEach((header, index) => {
      if (header) row[header] = (columns[index + 2] ?? "").trim();
    });

    if (!rawByCode[code]) rawByCode[code] = [];
    rawByCode[code].push(row);
  }

  if (statementPeriod) {
    sections.Statement = [{ "Field Name": "Period", "Field Value": statementPeriod }];
  }

  if (rawByCode.ACCT?.length) {
    sections["Account Information"] = flexAccountRows(rawByCode.ACCT[0]);
  }

  if (rawByCode.EQUT?.length) {
    sections["Net Asset Value"] = flexNavRows(latestFlexRow(rawByCode.EQUT, "ReportDate"), rawByCode.CNAV?.[0]);
    sections["Net Asset Value History"] = rawByCode.EQUT.map(flexNavHistoryRow);
  }

  if (rawByCode.CNAV?.length) {
    sections["Change in NAV"] = flexNavChangeRows(rawByCode.CNAV[0]);
    sections["Time Weighted Return History"] = rawByCode.CNAV.map(flexReturnHistoryRow);
  }

  if (rawByCode.POST?.length) {
    sections["Open Positions"] = flexPositionRows(latestFlexRows(rawByCode.POST, "ReportDate"));
  }

  if (rawByCode.TRNT?.length) {
    sections.Trades = rawByCode.TRNT
      .filter(isFlexOrderTradeRow)
      .map(flexTradeRow);
  }

  if (rawByCode.FIFO?.length) {
    sections["Realized & Unrealized Performance Summary"] = flexPlRows(rawByCode.FIFO);
  }

  if (rawByCode.MTMP?.length) {
    sections["Mark-to-Market Performance Summary"] = latestFlexRows(rawByCode.MTMP, "ReportDate").map(flexMtmRow);
  }

  if (rawByCode.FXTR?.length) {
    sections["Forex P/L Details"] = rawByCode.FXTR.map((row) => ({
      Date: row.DateTime || row.ReportDate || "",
      "Realized P/L": row["RealizedP/L"] || "0"
    }));
  }

  if (rawByCode.TIER?.length) {
    sections.Interest = rawByCode.TIER.map((row) => ({
      Date: row.ValueDate || row.ReportDate || "",
      Currency: row.CurrencyPrimary || "",
      Amount: row.TotalInterest || "0"
    }));
  }

  const feeRows = [
    ...(rawByCode.TRTX || []).map((row) => ({
      Date: row.Date || row.ReportDate || "",
      Currency: row.CurrencyPrimary || "",
      Amount: row.TaxAmount || "0"
    })),
    ...(rawByCode.UNBC || []).map((row) => ({
      Date: row["Date/Time"] || "",
      Currency: row.CurrencyPrimary || "",
      Amount: row.TotalCommission || "0"
    }))
  ];
  if (feeRows.length) sections.Fees = feeRows;

  if (rawByCode.RATE?.length) {
    sections["Base Currency Exchange Rate"] = rawByCode.RATE.map((row) => ({
      Currency: row.FromCurrency || "",
      "Base Currency": row.ToCurrency || "",
      Rate: row.Rate || "1"
    }));
  }

  return Object.fromEntries(Object.entries(sections).filter(([, value]) => value?.length));
}

function cleanFlexCell(value) {
  return String(value || "").trim().replace(/^\uFEFF/, "");
}

function latestFlexRow(rows, dateField) {
  return rows
    .slice()
    .sort((a, b) => {
      const dateA = parseDate(a[dateField])?.getTime() || 0;
      const dateB = parseDate(b[dateField])?.getTime() || 0;
      return dateB - dateA;
    })[0] || rows[0];
}

function latestFlexRows(rows, dateField) {
  const dates = rows
    .map((row) => parseDate(row[dateField]))
    .filter(Boolean)
    .map((date) => dateKey(date));

  if (!dates.length) return rows;

  const latestDate = dates.sort().at(-1);
  return rows.filter((row) => {
    const date = parseDate(row[dateField]);
    return date && dateKey(date) === latestDate;
  });
}

function flexAccountRows(row) {
  return [
    ["Account", row.ClientAccountID],
    ["Name", row.Name],
    ["Base Currency", row.CurrencyPrimary],
    ["Account Type", row.AccountType],
    ["Customer Type", row.CustomerType]
  ].map(([name, value]) => ({ "Field Name": name, "Field Value": value || "" }));
}

function flexNavRows(row, changeRow) {
  const rows = [
    { "Asset Class": "Cash", "Current Total": row.Cash || "0", Total: row.Cash || "0" },
    { "Asset Class": "Stocks", "Current Total": row.Stock || "0", Total: row.Stock || "0" },
    { "Asset Class": "Options", "Current Total": row.Options || "0", Total: row.Options || "0" },
    { "Asset Class": "Total", "Current Total": row.Total || "0", Total: row.Total || "0" }
  ];

  if (changeRow?.TWR) {
    rows.push({ "Time Weighted Rate of Return": changeRow.TWR });
  }

  return rows;
}

function flexNavHistoryRow(row) {
  return {
    Date: row.ReportDate || "",
    Cash: row.Cash || "0",
    Stocks: row.Stock || "0",
    Options: row.Options || "0",
    Total: row.Total || "0"
  };
}

function flexNavChangeRows(row) {
  const fields = [
    ["Starting Value", row.StartingValue],
    ["Mark-to-Market", row.Mtm],
    ["Deposits & Withdrawals", row.DepositsWithdrawals],
    ["Interest", row.Interest],
    ["Change in Interest Accruals", row.ChangeInInterestAccruals],
    ["Other Fees", sumFlexValues(row, ["OtherFees", "BrokerFees", "AdvisorFees", "ClientFees"])],
    ["Commissions", sumFlexValues(row, ["Commissions", "ForexCommissions"])],
    ["Sales Tax", sumFlexValues(row, ["SalesTax", "BillableSalesTax", "TransactionTax"])],
    ["Other FX Translations", row.FxTranslation],
    ["Ending Value", row.EndingValue]
  ];

  return fields.map(([name, value]) => ({ "Field Name": name, "Field Value": value || "0" }));
}

function flexReturnHistoryRow(row) {
  return {
    FromDate: row.FromDate || "",
    ToDate: row.ToDate || "",
    StartingValue: row.StartingValue || "0",
    EndingValue: row.EndingValue || "0",
    DepositsWithdrawals: row.DepositsWithdrawals || "0",
    AssetTransfers: row.AssetTransfers || "0",
    InternalCashTransfers: row.InternalCashTransfers || "0",
    TWR: row.TWR || ""
  };
}

function flexPositionRow(row) {
  return {
    DataDiscriminator: "Summary",
    "Asset Category": flexAssetCategory(row.AssetClass),
    Currency: row.CurrencyPrimary || "",
    Symbol: row.Symbol || "",
    Quantity: row.Quantity || "0",
    Mult: row.Multiplier || "1",
    "Cost Basis": row.CostBasisMoney || "0",
    "Close Price": row.MarkPrice || "0",
    Value: row.PositionValue || "0",
    "Unrealized P/L": row.FifoPnlUnrealized || "0"
  };
}

function flexPositionRows(rows) {
  const summaryRows = rows.filter((row) => String(row.LevelOfDetail || "").toUpperCase() === "SUMMARY");
  const selectedRows = summaryRows.length ? summaryRows : rows;
  return selectedRows.map(flexPositionRow);
}

function flexTradeRow(row) {
  return {
    DataDiscriminator: "Order",
    "Asset Category": flexAssetCategory(row.AssetClass),
    Currency: row.CurrencyPrimary || "",
    Symbol: row.Symbol || "",
    "Date/Time": row.DateTime || row.TradeDate || row.ReportDate || "",
    Quantity: row.Quantity || "0",
    "T. Price": row.TradePrice || "0",
    Proceeds: row.Proceeds || row.TradeMoney || "0",
    "Comm/Fee": row.IBCommission || "0",
    "Realized P/L": row.FifoPnlRealized || "0",
    "MTM P/L": row.MtmPnl || "0",
    Code: row["Notes/Codes"] || row.Code || ""
  };
}

function isFlexOrderTradeRow(row) {
  const level = String(row.LevelOfDetail || "").toUpperCase();
  if (level) return level === "ORDER";

  return Boolean(row.IBOrderID || row.OrderID || row.TradeMoney || row.Proceeds);
}

function flexPlRows(rows) {
  const symbolGroups = new Map();
  const hasSymbolRows = rows.some((row) => String(row.Symbol || "").trim());
  const allAssetsRows = rows.filter((row) =>
    !String(row.AssetClass || "").trim() &&
    !String(row.Symbol || "").trim()
  );
  const detailRows = rows.filter((row) => {
    if (allAssetsRows.includes(row)) return false;
    if (hasSymbolRows) return Boolean(String(row.Symbol || "").trim());
    return Boolean(String(row.AssetClass || "").trim());
  });
  const latestDetailRows = latestFlexRows(detailRows, "ReportDate");
  const latestAllAssetsRows = latestFlexRows(allAssetsRows, "ReportDate");

  for (const row of detailRows) {
    const category = flexAssetCategory(row.AssetClass);
    const symbol = row.Symbol || "";
    const key = `${category}\u001f${symbol}`;
    if (!symbolGroups.has(key)) {
      symbolGroups.set(key, { category, symbol, realized: 0, unrealized: 0 });
    }

    symbolGroups.get(key).realized += toNumber(row.TotalRealizedPnl);
  }

  for (const row of latestDetailRows) {
    const category = flexAssetCategory(row.AssetClass);
    const symbol = row.Symbol || "";
    const key = `${category}\u001f${symbol}`;
    if (!symbolGroups.has(key)) {
      symbolGroups.set(key, { category, symbol, realized: 0, unrealized: 0 });
    }

    symbolGroups.get(key).unrealized += toNumber(row.TotalUnrealizedPnl);
  }

  const result = [];
  const groups = new Map();

  for (const group of symbolGroups.values()) {
    if (!groups.has(group.category)) {
      groups.set(group.category, { realized: 0, unrealized: 0, total: 0, rows: [] });
    }

    const total = group.realized + group.unrealized;
    const assetGroup = groups.get(group.category);
    assetGroup.realized += group.realized;
    assetGroup.unrealized += group.unrealized;
    assetGroup.total += total;
    assetGroup.rows.push({
      "Asset Category": group.category,
      Symbol: group.symbol,
      "Realized Total": String(group.realized),
      "Unrealized Total": String(group.unrealized),
      Total: String(total)
    });
  }

  let allRealized = 0;
  let allUnrealized = 0;
  let allTotal = 0;

  for (const [category, group] of groups.entries()) {
    result.push(...group.rows);
    result.push({
      "Asset Category": "Total",
      "Realized Total": String(group.realized),
      "Unrealized Total": String(group.unrealized),
      Total: String(group.total)
    });
    allRealized += group.realized;
    allUnrealized += group.unrealized;
    allTotal += group.total;
  }

  if (allAssetsRows.length) {
    allRealized = allAssetsRows.reduce((sum, row) => sum + toNumber(row.TotalRealizedPnl), 0);
    allUnrealized = latestAllAssetsRows.reduce((sum, row) => sum + toNumber(row.TotalUnrealizedPnl), 0);
    allTotal = allRealized + allUnrealized;
  }

  result.push({
    "Asset Category": "Total (All Assets)",
    "Realized Total": String(allRealized),
    "Unrealized Total": String(allUnrealized),
    Total: String(allTotal)
  });

  return result;
}

function flexMtmRow(row) {
  return {
    "Asset Category": flexAssetCategory(row.AssetClass),
    Symbol: row.Symbol || "",
    "Current Price": row.ClosePrice || "0",
    "Mark-to-Market P/L Total": row.Total || row.TotalWithAccruals || "0"
  };
}

function flexAssetCategory(value) {
  const assetClass = String(value || "").toUpperCase();
  if (assetClass === "STK") return "Stocks";
  if (assetClass === "OPT" || assetClass === "IOPT" || assetClass.includes("OPTION")) return OPTION_ASSET;
  if (assetClass === "CASH" || assetClass === "FX" || assetClass === "FOREX") return "Forex";
  if (assetClass === "BOND") return "Bonds";
  return value || "Other";
}

function sumFlexValues(row, keys) {
  return String(keys.reduce((sum, key) => sum + toNumber(row[key]), 0));
}

function displayFlexDate(value) {
  const date = parseDate(value);
  return date ? dateKey(date) : (value || "");
}

function splitCsvRows(text) {
  const rows = [];
  let row = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      row += char + next;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      row += char;
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (row.trim()) rows.push(row);
      row = "";
      if (char === "\r" && next === "\n") index += 1;
      continue;
    }

    row += char;
  }

  if (row.trim()) rows.push(row);
  return rows;
}

export function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(value);
      value = "";
      continue;
    }

    value += char;
  }

  cells.push(value);
  return cells;
}

function parseAccountInfo(sections) {
  const infoRows = sections["Account Information"] || [];
  const statementRows = sections.Statement || [];
  const infoMap = new Map(
    infoRows.map((row) => [row["Field Name"], row["Field Value"]])
  );
  const statementMap = new Map(
    statementRows.map((row) => [row["Field Name"], row["Field Value"]])
  );

  return {
    account: infoMap.get("Account") || "",
    name: infoMap.get("Name") || "",
    baseCurrency: infoMap.get("Base Currency") || "USD",
    period: statementMap.get("Period") || infoMap.get("Period") || ""
  };
}

function parseExchangeRates(sections, baseCurrency) {
  const rates = { [baseCurrency || "USD"]: 1 };
  const baseRateRows = sections["Base Currency Exchange Rate"] || [];

  for (const row of baseRateRows) {
    const currency = row.Currency;
    const rate = toNumber(row.Rate);
    if (currency && currency !== baseCurrency && rate > 0) {
      rates[currency] = row["Base Currency"] === baseCurrency ? rate : 1 / rate;
    }
  }

  const mtmRows = sections["Mark-to-Market Performance Summary"] || [];

  for (const row of mtmRows) {
    if (row["Asset Category"] !== "Forex") continue;

    const currency = row.Symbol;
    const rate = toNumber(row["Current Price"]);
    if (currency && currency !== baseCurrency && rate > 0) {
      rates[currency] = rate;
    }
  }

  return rates;
}

function parseNetAssetValue(rows = [], baseCurrency) {
  const cashRow = rows.find((row) => row["Asset Class"] === "Cash");
  const totalRow = rows.find((row) => row["Asset Class"] === "Total");
  const returnRow = rows.find((row) => row["Time Weighted Rate of Return"]);

  return {
    cash: toNumber(readValue(cashRow, ["Current Total", "Total"])),
    total: toNumber(readValue(totalRow, ["Current Total", "Total"])),
    rateOfReturn: toNumber(readValue(returnRow, ["Time Weighted Rate of Return"])),
    baseCurrency
  };
}

function parseNavChange(rows = []) {
  const map = new Map(rows.map((row) => [row["Field Name"], row["Field Value"]]));
  const fields = [
    ["startingValue", "期初净值", "Starting Value"],
    ["markToMarket", "盯市变化", "Mark-to-Market"],
    ["depositsAndWithdrawals", "出入金", "Deposits & Withdrawals"],
    ["interest", "利息", "Interest"],
    ["changeInInterestAccruals", "应计利息", "Change in Interest Accruals"],
    ["otherFees", "其他费用", "Other Fees"],
    ["commissions", "佣金", "Commissions"],
    ["salesTax", "销售税", "Sales Tax"],
    ["otherFXTranslations", "汇兑折算", "Other FX Translations"],
    ["endingValue", "期末净值", "Ending Value"]
  ];

  return fields.map(([key, label, source]) => ({
    key,
    label,
    value: toNumber(map.get(source))
  }));
}

function parseNavHistory(rows = [], returnRows = [], periodReturn = 0) {
  const navByDate = new Map(
    rows
      .map((row) => {
        const date = parseDate(row.Date || row.ReportDate);
        return [date ? dateKey(date) : "", {
          nav: toNumber(row.Total),
          cash: toNumber(row.Cash),
          stocks: toNumber(row.Stocks),
          options: toNumber(row.Options)
        }];
      })
      .filter(([date, row]) => date && row.nav > 0)
  );

  const returnPoints = parseDailyReturnHistory(returnRows, navByDate);
  if (returnPoints.length >= 2) return returnPoints;

  const points = rows
    .map((row) => {
      const date = parseDate(row.Date || row.ReportDate);
      return {
        date: date ? dateKey(date) : "",
        nav: toNumber(row.Total),
        cash: toNumber(row.Cash),
        stocks: toNumber(row.Stocks),
        options: toNumber(row.Options),
        source: "nav"
      };
    })
    .filter((row) => row.date && row.nav > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const baseNav = points.find((row) => row.nav > 0)?.nav || 0;
  return points.map((row) => ({
    ...row,
    returnRate: baseNav > 0 ? ((row.nav - baseNav) / baseNav) * 100 : 0,
    periodReturn,
    flowAdjusted: false
  }));
}

function parseDailyReturnHistory(rows = [], navByDate = new Map()) {
  const dailyRows = rows
    .map((row) => {
      const date = parseDate(row.ToDate || row.FromDate);
      return {
        date: date ? dateKey(date) : "",
        twr: toNumber(row.TWR),
        startingValue: toNumber(row.StartingValue),
        endingValue: toNumber(row.EndingValue),
        depositsWithdrawals: toNumber(row.DepositsWithdrawals),
        assetTransfers: toNumber(row.AssetTransfers),
        internalCashTransfers: toNumber(row.InternalCashTransfers)
      };
    })
    .filter((row) => row.date && row.endingValue > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (dailyRows.length < 2) return [];

  let cumulative = 1;
  return dailyRows.map((row) => {
    cumulative *= 1 + row.twr / 100;
    const nav = navByDate.get(row.date) || {};
    return {
      date: row.date,
      nav: row.endingValue || nav.nav || 0,
      cash: nav.cash || 0,
      stocks: nav.stocks || 0,
      options: nav.options || 0,
      dailyReturn: row.twr,
      returnRate: (cumulative - 1) * 100,
      depositsWithdrawals: row.depositsWithdrawals,
      assetTransfers: row.assetTransfers,
      internalCashTransfers: row.internalCashTransfers,
      source: "twr",
      flowAdjusted: true
    };
  });
}

function latestFlowAdjustedReturn(navHistory = []) {
  const rows = navHistory.filter((row) => row.flowAdjusted && Number.isFinite(row.returnRate));
  return rows.length ? rows[rows.length - 1].returnRate : null;
}

function parsePlSummary(rows = [], trades = []) {
  const plSummary = {
    stocks: { realized: 0, unrealized: 0, total: 0 },
    options: { realized: 0, unrealized: 0, total: 0 },
    forex: { realized: 0, unrealized: 0, total: 0 },
    total: { realized: 0, unrealized: 0, total: 0 }
  };
  const closeDateBySymbol = latestCloseDateBySymbol(trades);
  const closedPositions = [];
  let lastAssetCategory = "";

  for (const row of rows) {
    let assetCategory = row["Asset Category"] || "";
    if (assetCategory === OPTION_ASSET) assetCategory = "Options";

    const symbol = row.Symbol;

    if (assetCategory && !assetCategory.startsWith("Total")) {
      lastAssetCategory = assetCategory;
    }

    if (symbol && assetCategory && !assetCategory.startsWith("Total")) {
      const realizedPL = toNumber(row["Realized Total"]);
      if (realizedPL !== 0) {
        closedPositions.push({
          assetCategory,
          symbol,
          baseSymbol: parseOptionSymbol(symbol).baseSymbol,
          realizedPL,
          closeDate: closeDateBySymbol.get(symbol) || ""
        });
      }
    }

    if (assetCategory === "Total") {
      const summary = readPlNumbers(row);
      if (lastAssetCategory === "Stocks") plSummary.stocks = summary;
      if (lastAssetCategory === "Options") plSummary.options = summary;
      if (lastAssetCategory === "Forex") plSummary.forex = summary;
    }

    if (assetCategory === "Total (All Assets)") {
      plSummary.total = readPlNumbers(row);
    }
  }

  return { plSummary, closedPositions };
}

function latestCloseDateBySymbol(trades = []) {
  const map = new Map();
  const closingTrades = trades
    .filter((row) => row.DataDiscriminator === "Order" && toNumber(row["Realized P/L"]) !== 0)
    .map((row) => ({
      row,
      date: parseDate(row["Date/Time"])
    }))
    .filter((item) => item.date)
    .sort((a, b) => b.date - a.date);

  for (const item of closingTrades) {
    const symbol = item.row.Symbol;
    if (symbol && !map.has(symbol)) {
      map.set(symbol, item.date.toISOString());
    }
  }

  return map;
}

function readPlNumbers(row) {
  return {
    realized: toNumber(row["Realized Total"]),
    unrealized: toNumber(row["Unrealized Total"]),
    total: toNumber(row.Total)
  };
}

function parseOpenPositions(rows = [], exchangeRates) {
  const positions = rows
    .filter((row) => row.DataDiscriminator === "Summary" && row.Symbol)
    .map((row) => {
      let assetCategory = row["Asset Category"] || "Other";
      if (assetCategory === OPTION_ASSET) assetCategory = "Options";

      const currency = row.Currency || "USD";
      const rate = exchangeRates[currency] || 1;
      const option = parseOptionSymbol(row.Symbol);
      const quantity = toNumber(row.Quantity);

      return {
        assetCategory,
        symbol: row.Symbol,
        baseSymbol: option.baseSymbol,
        quantity,
        side: quantity < 0 ? "Short" : "Long",
        multiplier: toNumber(row.Mult),
        costBasis: toNumber(row["Cost Basis"]) * rate,
        closePrice: toNumber(row["Close Price"]),
        value: toNumber(row.Value) * rate,
        dividends: 0,
        unrealizedPL: toNumber(row["Unrealized P/L"]) * rate,
        currency,
        isOption: option.isOption,
        optionType: option.optionType || "",
        strikePrice: option.strikePrice || 0,
        expiry: option.expiry || ""
      };
    });

  return aggregateOpenPositions(positions)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

function aggregateOpenPositions(positions) {
  const groups = new Map();

  for (const position of positions) {
    const key = [
      position.assetCategory,
      position.symbol,
      position.currency,
      position.side,
      position.multiplier
    ].join("\u001f");
    const weight = Math.abs(position.quantity * (position.multiplier || 1));

    if (!groups.has(key)) {
      groups.set(key, {
        ...position,
        quantity: 0,
        costBasis: 0,
        value: 0,
        dividends: 0,
        unrealizedPL: 0,
        lotCount: 0,
        closePriceWeightedTotal: 0,
        closePriceWeight: 0
      });
    }

    const group = groups.get(key);
    group.quantity += position.quantity;
    group.costBasis += position.costBasis;
    group.value += position.value;
    group.dividends += position.dividends || 0;
    group.unrealizedPL += position.unrealizedPL;
    group.lotCount += position.lotCount || 1;
    group.closePriceWeightedTotal += position.closePrice * weight;
    group.closePriceWeight += weight;
  }

  return Array.from(groups.values())
    .filter((position) => position.quantity !== 0 || position.value !== 0)
    .map((position) => {
      const {
        closePriceWeightedTotal,
        closePriceWeight,
        ...cleanPosition
      } = position;

      return {
        ...cleanPosition,
        closePrice: closePriceWeight
          ? closePriceWeightedTotal / closePriceWeight
          : cleanPosition.closePrice
      };
    });
}

function parseDividendIncome(sections, exchangeRates) {
  const bySymbol = {};
  let total = 0;

  for (const row of sections.Dividends || []) {
    if (row.Currency === "Total") continue;

    const symbol = parseDividendSymbol(row);
    if (!symbol) continue;

    const currency = row.Currency || "USD";
    const value = toNumber(row.Amount) * (exchangeRates[currency] || 1);
    if (!value) continue;

    bySymbol[symbol] = (bySymbol[symbol] || 0) + value;
    total += value;
  }

  return {
    bySymbol,
    total
  };
}

function applyPositionDividends(positions, dividendBySymbol) {
  return positions.map((position) => {
    const symbols = new Set([
      position.symbol,
      position.baseSymbol,
      parseOptionSymbol(position.symbol).baseSymbol
    ].filter(Boolean));
    const dividends = Array.from(symbols).reduce((sum, symbol) => sum + (dividendBySymbol[symbol] || 0), 0);
    return {
      ...position,
      dividends
    };
  });
}

function analyzeTrades(rows = [], exchangeRates) {
  const orderTrades = rows.filter((row) => row.DataDiscriminator === "Order");
  let totalCommissions = 0;
  let optionPremium = 0;
  let realizedPL = 0;
  let stockOrders = 0;
  let optionOrders = 0;
  let forexOrders = 0;
  const dates = [];
  const topRealizedTrades = [];

  for (const row of orderTrades) {
    const date = parseDate(row["Date/Time"]);
    if (date) dates.push(date);

    const category = row["Asset Category"];
    if (category === "Stocks") stockOrders += 1;
    if (category === OPTION_ASSET) optionOrders += 1;
    if (category === "Forex") forexOrders += 1;

    const currency = row.Currency || "USD";
    const rate = exchangeRates[currency] || 1;
    const commission = toNumber(readCommission(row)) * rate;
    const tradeRealized = toNumber(row["Realized P/L"]) * rate;
    totalCommissions += Math.abs(commission);
    realizedPL += tradeRealized;

    if (category === OPTION_ASSET && row.Code?.includes("O") && toNumber(row.Quantity) < 0) {
      optionPremium += (toNumber(row.Proceeds) + toNumber(readCommission(row))) * rate;
    }

    if (tradeRealized !== 0) {
      topRealizedTrades.push({
        date: date ? date.toISOString() : "",
        symbol: row.Symbol || "",
        category,
        realizedPL: tradeRealized,
        currency
      });
    }
  }

  topRealizedTrades.sort((a, b) => Math.abs(b.realizedPL) - Math.abs(a.realizedPL));

  return {
    orderCount: orderTrades.length,
    stockOrders,
    optionOrders,
    forexOrders,
    totalCommissions,
    optionPremium,
    realizedPL,
    firstTradeDate: dates.length ? new Date(Math.min(...dates)).toISOString() : "",
    lastTradeDate: dates.length ? new Date(Math.max(...dates)).toISOString() : "",
    topRealizedTrades: topRealizedTrades.slice(0, 10)
  };
}

function parseTradeDetails(rows = [], exchangeRates) {
  return (rows || [])
    .filter((row) => row.DataDiscriminator === "Order")
    .map((row) => {
      const date = parseDate(row["Date/Time"]);
      const currency = row.Currency || "USD";
      const rate = exchangeRates[currency] || 1;
      const quantity = toNumber(row.Quantity);
      const price = toNumber(row["T. Price"]);
      const proceeds = toNumber(row.Proceeds) * rate;
      const commission = toNumber(readCommission(row)) * rate;
      const realizedPL = toNumber(row["Realized P/L"]) * rate;
      const mtmPL = toNumber(row["MTM P/L"]) * rate;

      return {
        date: date ? dateKey(date) : "",
        dateTime: date ? date.toISOString() : "",
        month: date ? monthKey(date) : "",
        symbol: row.Symbol || "",
        baseSymbol: parseOptionSymbol(row.Symbol || "").baseSymbol || row.Symbol || "",
        assetCategory: row["Asset Category"] || "",
        currency,
        side: quantity < 0 ? "Sell" : "Buy",
        quantity,
        price,
        proceeds,
        grossValue: Math.abs(proceeds),
        commission,
        realizedPL,
        mtmPL,
        code: row.Code || ""
      };
    })
    .filter((row) => row.date)
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime));
}

function analyzeDailyTrades(rows = [], exchangeRates) {
  const daily = new Map();
  const ensureDay = (date) => {
    const key = dateKey(date);
    if (!daily.has(key)) {
      daily.set(key, {
        date: key,
        month: monthKey(date),
        day: date.getDate(),
        tradeCount: 0,
        realizedPL: 0,
        mtmPL: 0,
        grossTradeValue: 0,
        commissions: 0,
        symbols: new Set()
      });
    }
    return daily.get(key);
  };

  for (const trade of rows || []) {
    if (trade.DataDiscriminator !== "Order") continue;

    const date = parseDate(trade["Date/Time"]);
    if (!date) continue;

    const currency = trade.Currency || "USD";
    const rate = exchangeRates[currency] || 1;
    const row = ensureDay(date);
    const symbol = trade.Symbol || "";

    row.tradeCount += 1;
    row.realizedPL += toNumber(trade["Realized P/L"]) * rate;
    row.mtmPL += toNumber(trade["MTM P/L"]) * rate;
    row.grossTradeValue += Math.abs(toNumber(trade.Proceeds) * rate);
    row.commissions += Math.abs(toNumber(readCommission(trade)) * rate);
    if (symbol) row.symbols.add(symbol);
  }

  return Array.from(daily.values())
    .map((row) => ({
      ...row,
      symbolCount: row.symbols.size,
      symbols: Array.from(row.symbols).sort()
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function analyzeMonthlySummary(sections, exchangeRates) {
  const monthly = new Map();
  const ensureMonth = (date) => {
    const key = monthKey(date);
    if (!monthly.has(key)) {
      monthly.set(key, {
        month: key,
        optionsPL: 0,
        optionsPremium: 0,
        stocksPL: 0,
        forexPL: 0,
        syepIncome: 0,
        interest: 0,
        commissions: 0,
        fees: 0,
        net: 0
      });
    }
    return monthly.get(key);
  };

  for (const trade of sections.Trades || []) {
    if (trade.DataDiscriminator !== "Order") continue;

    const date = parseDate(trade["Date/Time"]);
    if (!date) continue;

    const row = ensureMonth(date);
    const currency = trade.Currency || "USD";
    const rate = exchangeRates[currency] || 1;
    const category = trade["Asset Category"];
    const realized = toNumber(trade["Realized P/L"]) * rate;
    const commission = toNumber(readCommission(trade)) * rate;

    row.commissions += Math.abs(commission);

    if (category === OPTION_ASSET) {
      row.optionsPL += realized;
      if (trade.Code?.includes("O") && toNumber(trade.Quantity) < 0) {
        row.optionsPremium += (toNumber(trade.Proceeds) + toNumber(readCommission(trade))) * rate;
      }
    } else if (category === "Stocks") {
      row.stocksPL += realized;
    } else if (category === "Forex") {
      row.forexPL += toNumber(trade["MTM P/L"]) * rate || realized;
    }
  }

  for (const row of sections["Forex P/L Details"] || []) {
    const date = parseDate(row.Date);
    if (!date) continue;
    ensureMonth(date).forexPL += toNumber(row["Realized P/L"]);
  }

  for (const row of sections["Stock Yield Enhancement Program Securities Lent Interest Details"] || []) {
    const date = parseDate(row["Value Date"]);
    if (!date) continue;
    const currency = row.Currency || "USD";
    ensureMonth(date).syepIncome += toNumber(row["Interest Paid to Customer"]) * (exchangeRates[currency] || 1);
  }

  for (const row of sections.Interest || []) {
    const date = parseDate(row.Date);
    if (!date) continue;
    const currency = row.Currency || "USD";
    ensureMonth(date).interest += toNumber(row.Amount) * (exchangeRates[currency] || 1);
  }

  for (const row of sections.Fees || []) {
    const date = parseDate(row.Date);
    if (!date) continue;
    const currency = row.Currency || "USD";
    ensureMonth(date).fees += Math.abs(toNumber(row.Amount) * (exchangeRates[currency] || 1));
  }

  return Array.from(monthly.values())
    .map((row) => ({
      ...row,
      net:
        row.optionsPL +
        row.stocksPL +
        row.forexPL +
        row.syepIncome +
        row.interest -
        row.commissions -
        row.fees
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function analyzeTickerPL(closedPositions) {
  const map = new Map();

  for (const position of closedPositions) {
    const key = position.baseSymbol || position.symbol;
    map.set(key, (map.get(key) || 0) + position.realizedPL);
  }

  return Array.from(map.entries())
    .map(([ticker, realizedPL]) => ({ ticker, realizedPL }))
    .sort((a, b) => Math.abs(b.realizedPL) - Math.abs(a.realizedPL));
}

function summarizePositions(positions, key) {
  const map = new Map();

  for (const position of positions) {
    const name = position[key] || "Other";
    map.set(name, (map.get(name) || 0) + Math.abs(position.value));
  }

  const total = Array.from(map.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(map.entries())
    .map(([name, value]) => ({
      name,
      value,
      weight: total > 0 ? value / total : 0
    }))
    .sort((a, b) => b.value - a.value);
}

function buildWarnings(sections, nav, positions, tradeSummary) {
  const warnings = [];

  if (!sections["Account Information"]) warnings.push("未找到 Account Information 区块。");
  if (!sections["Net Asset Value"]) warnings.push("未找到 Net Asset Value 区块。");
  if (!sections.Trades) warnings.push("未找到 Trades 区块，交易分析会为空。");
  if (!sections["Open Positions"]) warnings.push("未找到 Open Positions 区块，持仓列表会为空。");
  if (!nav.total && positions.length === 0 && tradeSummary.orderCount === 0) {
    warnings.push("文件结构不像标准 IBKR Activity Statement CSV。");
  }

  return warnings;
}

function parseOptionSymbol(symbol) {
  if (!symbol) return { isOption: false, baseSymbol: "" };

  const parts = symbol.trim().split(/\s+/);
  const baseSymbol = parts[0] || "";
  if (parts.length < 4) return { isOption: false, baseSymbol };

  const optionType = parts[parts.length - 1];
  const strikePrice = toNumber(parts[parts.length - 2]);
  const expiry = parts[parts.length - 3];

  if ((optionType === "P" || optionType === "C") && strikePrice > 0) {
    return {
      isOption: true,
      optionType,
      strikePrice,
      expiry,
      baseSymbol
    };
  }

  return { isOption: false, baseSymbol };
}

function parseDividendSymbol(row = {}) {
  const explicitSymbol = String(row.Symbol || "").trim();
  if (explicitSymbol && explicitSymbol !== "Total") {
    return parseOptionSymbol(explicitSymbol).baseSymbol || explicitSymbol;
  }

  const description = String(row.Description || "").trim();
  const parenMatch = description.match(/^([A-Z][A-Z0-9.\-]{0,12})\s*\(/);
  if (parenMatch) return parenMatch[1];

  const textMatch = description.match(/\b([A-Z][A-Z0-9.\-]{0,12})\b(?=.*\b(?:Cash Dividend|Dividend|Payment in Lieu)\b)/i);
  return textMatch ? textMatch[1] : "";
}

function readCommission(row) {
  return (
    row["Comm/Fee"] ??
    row["Commission"] ??
    Object.entries(row).find(([key]) => key.toLowerCase().startsWith("comm"))?.[1] ??
    "0"
  );
}

function readValue(row, keys) {
  if (!row) return "";
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== "") return row[key];
  }
  return "";
}

function toNumber(value) {
  if (value === undefined || value === null) return 0;
  const raw = String(value).trim();
  if (!raw || raw === "--") return 0;

  const negative = raw.startsWith("(") && raw.endsWith(")");
  const cleaned = raw.replace(/[,$%\s()]/g, "");
  const number = Number.parseFloat(cleaned);
  if (Number.isNaN(number)) return 0;
  return negative ? -number : number;
}

function parseDate(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(/\s+/g, " ");

  const compactDate = normalized.match(
    /^(\d{4})(\d{2})(\d{2})(?:[,\s;:-]*(\d{2})(\d{2})(?:(\d{2}))?)?/
  );
  if (compactDate) {
    return buildLocalDate(
      compactDate[1],
      compactDate[2],
      compactDate[3],
      compactDate[4],
      compactDate[5],
      compactDate[6]
    );
  }

  const dashedDateWithCompactTime = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[,\sT;]+(\d{1,2})(\d{2})(?:(\d{2}))?/
  );
  if (dashedDateWithCompactTime) {
    return buildLocalDate(
      dashedDateWithCompactTime[1],
      dashedDateWithCompactTime[2],
      dashedDateWithCompactTime[3],
      dashedDateWithCompactTime[4],
      dashedDateWithCompactTime[5],
      dashedDateWithCompactTime[6]
    );
  }

  const isoLike = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[,\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (isoLike) {
    return buildLocalDate(isoLike[1], isoLike[2], isoLike[3], isoLike[4], isoLike[5], isoLike[6]);
  }

  const slashDate = normalized.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (slashDate) {
    return buildLocalDate(slashDate[3], slashDate[1], slashDate[2], slashDate[4], slashDate[5], slashDate[6]);
  }

  const date = new Date(normalized.replace(/,/g, " "));
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildLocalDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const values = [year, month, day, hour || 0, minute || 0, second || 0].map(Number);
  if (values.some((part) => !Number.isFinite(part))) return null;

  const date = new Date(values[0], values[1] - 1, values[2], values[3], values[4], values[5]);
  if (
    date.getFullYear() !== values[0] ||
    date.getMonth() !== values[1] - 1 ||
    date.getDate() !== values[2]
  ) {
    return null;
  }
  return date;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
