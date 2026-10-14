import { describe, expect, it } from "vitest";
import { matchCity, nextRecentZones, zoneLabel } from "../../src/domain/timezones";

const zones = Intl.supportedValuesOf("timeZone");

describe("matchCity (C7)", () => {
  it.each([
    ["London", "Europe/London"],
    ["new york", "America/New_York"],
    ["  Los   Angeles ", "America/Los_Angeles"],
    ["buenos aires", "America/Buenos_Aires"],
    ["Singapore", "Asia/Singapore"],
  ])("%s → %s", (input, zone) => {
    expect(matchCity(input, zones)).toEqual({ zone });
  });

  it("asks when a city name is shared, or only the start of a name was typed", () => {
    expect(matchCity("Springfield", ["Region/Springfield", "Other/Springfield"])).toEqual({
      choose: ["Region/Springfield", "Other/Springfield"],
    });
    expect(matchCity("Kuala", zones)).toEqual({ choose: ["Asia/Kuala_Lumpur"] });
  });

  it.each(["", "Lo", "San", "Gotham", "Europe/Nowhere", "12:00"])("refuses %s", (input) => {
    expect(matchCity(input, zones)).toBeNull();
  });
});

describe("recent zones", () => {
  it("keeps the three most recent, newest first, without the current one", () => {
    expect(nextRecentZones("Asia/Singapore", [], "Europe/London")).toEqual(["Asia/Singapore"]);
    expect(
      nextRecentZones("Europe/London", ["Asia/Singapore", "Asia/Tokyo", "UTC"], "Asia/Singapore"),
    ).toEqual(["Europe/London", "Asia/Tokyo", "UTC"]);
  });

  it("labels zones by city", () => {
    expect(zoneLabel("America/Los_Angeles")).toBe("Los Angeles");
    expect(zoneLabel("UTC")).toBe("UTC");
  });
});
