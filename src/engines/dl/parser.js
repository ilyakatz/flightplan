const moment = require("moment-timezone");

const Award = require("../../Award");
const Flight = require("../../Flight");
const Parser = require("../../Parser");
const Segment = require("../../Segment");
const { cabins } = require("../../consts");
const utils = require("../../utils");
const request = require("sync-request");

// Regex patterns
const reQuantity = /only\s(\d+)\s+left\sat/i;

const cabinCodes = {
  E: cabins.economy,
  P: cabins.premium,
  B: cabins.business,
  F: cabins.first
};
module.exports = class extends Parser {
  parse(results) {
    const $ = results.$("results");

    // Return all elements that represents specific flights
    // eg. https://monosnap.com/file/gtFnd4VZXeAXddatfYBGiQzruwMAv8
    const flights = this.parseFlights($, ".flightcardContainer");

    return flights;
  }

  parseFlights($, sel) {
    // When working on a new parser, log the output and do experimentation in browser
    // console.log("#parseFlight: Sel is ");
    // console.log("*********************");
    // console.log($(sel));
    // console.log("*********************");
    const { engine, query } = this.results;

    // Iterate over flights
    const awards = [];

    $(sel).each((_, row) => {
      // Get cities, and direction
      const { fromCity, toCity } = this.generateCities($, row);

      // Get departure / arrival dates
      const { departDate } = this.generateDates($, fromCity);

      // By default, Delta does not show any arrival dates
      // hence default arrivale date is the same as departure date
      const defaultArrivalDate = departDate;

      // Get departure / arrival times
      const { departTimeMoment, arrivalTimeMoment } = this.generateTimes(
        $,
        row,
        departDate,
        defaultArrivalDate,
        fromCity,
        toCity
      );

      const segments = this.createSegmentsForRow(
        $,
        row,
        fromCity,
        departDate,
        departTimeMoment,
        arrivalTimeMoment,
        defaultArrivalDate
      );

      // Get cabins / quantity for award
      this.generateAwards($, row, segments, engine, awards);
    });

    return awards;
  }

  generateCities($, row) {
    const airports = $(row).find(".flightSecFocus");
    const fromCity = airports
      .first()
      .text()
      .trim()
      .split(" ")[3];

    const toCity = $(row)
      .find(".flightStopLayover")
      .last()
      .text()
      .trim()
      .split(" ")[3];
    return { fromCity, toCity };
  }

  generateDates($, fromCity) {
    const timezone = utils.airportTimezone(fromCity);
    const strDepartDate = $(".airportinfo")
      .text()
      .trim();
    let departDate = moment(strDepartDate);
    departDate = moment(moment(strDepartDate), timezone);
    return { departDate };
  }

  getArrivalDate(defaultArrivalDate, $, row) {
    let arrivalDate = defaultArrivalDate;
    if ($(row).find(".travelDate").length > 0) {
      const strArrivalDate = $(row)
        .find(".travelDate")
        .text()
        .trim();
      arrivalDate = moment(strArrivalDate, "ddd D MMM").format("YYYY-MM-DD");
    }
    return arrivalDate;
  }

  generateTimes($, row, departDate, arrivalDate, departCity, arrivalCity) {
    let departTimeMoment = this.generateDepartureMoment(
      $,
      row,
      departCity,
      departDate
    );

    let arrivalTimeMoment = this.generateArrivalTime(
      $,
      row,
      arrivalCity,
      arrivalDate
    );

    return { departTimeMoment, arrivalTimeMoment };
  }

  generateDepartureMoment($, row, departCity, departDate) {
    const departTimeStr = $(row)
      .find(".trip-time.pr0-sm-down")
      .first()
      .text()
      .trim();
    let departTimeMoment = this.convertToProperMoment(
      departCity,
      departDate,
      departTimeStr
    );
    return departTimeMoment;
  }

  /**
   *
   * @param {*} $
   * @param {String} row
   * @param {String} arrivalCity airport code
   * @param {moment} arrivalDate
   */
  generateArrivalTime($, row, arrivalCity, arrivalDate) {
    const arrivalTimeStr = $(row)
      .find(".trip-time.pl0-sm-down")
      .first()
      .text()
      .trim();
    let arrivalTimeMoment = this.convertToProperMoment(
      arrivalCity,
      arrivalDate,
      arrivalTimeStr
    );
    return arrivalTimeMoment;
  }

  /**
   *
   * @param {String} city airport code
   * @param {moment} date
   * @param {String} time time in format "hh:mm"
   */
  convertToProperMoment(city, date, time) {
    const timezone = utils.airportTimezone(city);
    date = date.startOf("days");
    date = moment.tz(date, timezone).startOf("days");
    let timeMoment = moment(time, "hh:mm a").format("HH:mm");
    const timeInMinutes = moment.duration(timeMoment).asMinutes();
    timeMoment = date.add(timeInMinutes, "minutes");
    return timeMoment;
  }

  generateAwards($, row, segments, engine, awards) {
    $(row)
      .find(".farecellitem")
      .each((_, cabinElement) => {
        if (segments.indexOf(undefined) > -1) {
          console.log(
            "One of the segment is undefined. Award cannot be created"
          );
        } else if (!segments) {
          console.log("No segments!");
        } else {
          const award = this.createAwardObject(
            segments,
            $,
            cabinElement,
            engine
          );
          // console.log("Award is " + award);
          if (award) {
            awards.push(award);
          }
        }
      });
  }

  /**
   *
   * @param {[]} segments
   * @param {*} $
   * @param {String} cabinElement HTML element that represents one cell in the cabin column
   * @param {*} engine
   */
  createAwardObject(segments, $, cabinElement, engine) {
    const flight = new Flight(segments);
    const seatsLeft = this.extractSeatsLeft($, cabinElement);
    const cabin = this.parseCabin($(cabinElement));
    const fare = this.findFare(cabin);
    const cabins = flight.segments.map(x => cabin);

    let mileageCost = 0;
    let fees = 0;
    let mileageCostStr = $(cabinElement)
      .find(".milesValue")
      .text();
    if (mileageCostStr) {
      let matcher = mileageCostStr.match(/([\d,])+/);
      mileageCost = parseInt(matcher[0].replace(",", ""));

      // TODO: validCurrency method is too strict so it fails if currency symbol is used
      // matcher = mileageCostStr.match(/\S(.[\d.])+$/);
      // fees = matcher[0];
    }
    if (seatsLeft > 0) {
      const award = new Award(
        {
          engine,
          fare,
          cabins,
          quantity: seatsLeft,
          mileageCost: mileageCost
        },
        flight
      );
      return award;
    } else {
      return undefined;
    }
  }

  extractSeatsLeft($, cabinElement) {
    const seatsLeftStr = $(cabinElement)
      .find(".seatLeft")
      .text()
      .trim();
    // If there is no special note, the default value is assume to be 7
    let seatsLeft = seatsLeftStr ? parseInt(seatsLeftStr) : 7;
    if ($(cabinElement).find(".soldout").length > 0) {
      seatsLeft = 0;
    }
    return seatsLeft;
  }

  createSegmentsForRow(
    $,
    row,
    fromCity,
    departDate,
    departTime,
    defaultArrivalTime,
    defaultArrivalDate
  ) {
    const segments = [];
    let index = 0;

    const withinRow = $(row).find(".upsellpopupanchor.ng-star-inserted");

    withinRow.each((_, segmentDetail) => {
      var { segment, toCity } = this.extractSegment(
        $,
        row,
        index,
        segmentDetail,
        defaultArrivalDate,
        departDate,
        fromCity,
        defaultArrivalTime,
        departTime
      );
      // console.log(`Segment created is ${segment}`);
      segments.push(segment);
      fromCity = toCity;

      // Increment index to indicate next leg(segment) of the flight
      index++;
    });
    // console.log(segments);
    return segments;
  }

  extractSegment(
    $,
    row,
    index,
    segmentDetail,
    defaultArrivalDate,
    departDate,
    fromCity,
    finalArrivalTime,
    departTime
  ) {
    const toCityEl = $(row).find(".flightStopLayover")[index];
    let toCity;
    let nextConnectionMinutes;
    ({ toCity, nextConnectionMinutes } = this.extractConnectionDetails(
      $(toCityEl).text()
    ));
    const { aircraft, airline, flightNumber } = this.getFlightDetails(
      $,
      segmentDetail
    );

    let arrivalDate = this.getArrivalDate(defaultArrivalDate, $, row);
    const lagDays = this.calculateLagDays(departDate, arrivalDate);
    let arrivalTimeCalculated, departTimeCalculated;
    // Delta makes it difficult to get data about connecting flights
    // So use external data provider for these flights
    const numberOfLayovers = this.calculateNumberOfLayovers($, row);

    if (numberOfLayovers > 0) {
      try {
        const res = this.getArrivalTimeFromExternal(
          airline,
          flightNumber,
          toCity,
          fromCity,
          departDate
        );

        arrivalTimeCalculated = res.arrivalTimeMoment;
        departTimeCalculated = res.departureTimeMoment;
      } catch (err) {
        arrivalTimeCalculated = undefined;
        departTimeCalculated = undefined;
      }
    } else {
      arrivalTimeCalculated = finalArrivalTime;
      departTimeCalculated = departTime;
    }
    // Add segment
    let segment;
    if (arrivalTimeCalculated && departTimeCalculated) {
      segment = new Segment({
        aircraft: aircraft,
        airline: airline,
        flight: `${airline}${flightNumber}`,
        fromCity: fromCity,
        toCity,
        date: departDate,
        departure: departTimeCalculated,
        arrival: arrivalTimeCalculated,
        lagDays: lagDays,
        nextConnection: nextConnectionMinutes,
        //TODO
        cabin: cabins.business,
        stops: numberOfLayovers
      });
    } else {
      segment = undefined;
    }
    return { segment, toCity };
  }

  test() {
    request("http://www.google.com", function(error, response, body) {});
  }

  getArrivalTimeFromExternal(
    airline,
    flightNumber,
    toCity,
    fromCity,
    departDate
  ) {
    url = "https://www.delta.com/shop/modals/flightspecific";

    headers = {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36",
      "content-type": "application/json; charset=UTF-8",
      "Accept-Encoding": "compress",
      cachekey: "d6469dbe-b47e-4f46-be02-12b900011c7c"
    };

    data = {
      legList: [
        {
          originAirportCode: "BOS",
          destinationAirportCode: "JFK",
          schedLocalDepartDate: "2020-03-10T08:30",
          marketingAirlineCode: "DL",
          operatingAirlineCode: "9E",
          classOfServiceList: ["NE", "NV", "SN", "OZ"],
          flightNumber: "5419"
        }
      ],
      pageId: "dynamic-modal",
      appId: "sho",
      channelId: "ecomm"
    };

    res = request("GET", url, {
      headers: headers,
      data: JSON.stringify(data)
    });

    data = {};

    var options = {
      url: url,
      headers: headers,
      data: data
    };

    function callback(error, response, body) {
      console.log("calling back " + body);
    }

    request(options, function(error, response, body) {
      console.log(response);
      console.log(response.request.req.toCurl());
    });

    // const year = departDate.format("Y");
    // const month = departDate.format("MM");
    // const day = departDate.format("DD");
    // console.log(` ${year} ${month} ${day}`);
    const url = `https://www.flightstats.com/v2/flight-tracker/${airline}/${flightNumber}?year=${year}&month=${month}&date=${day}`;

    const res = request("GET", url);
    const body = res.getBody("utf-8");
    // const matcher = body.match(/__NEXT_DATA__\s=(.*)/);
    // const nextDataJson = matcher[1];
    const nextData = JSON.parse(nextDataJson);

    let scheduledArrival, scheduledDeparture;
    const arrivalTimezone = utils.airportTimezone(toCity);
    const departureTimezone = utils.airportTimezone(fromCity);
    try {
      scheduledArrival =
        nextData["props"]["initialState"]["flightTracker"]["flight"][
          "schedule"
        ]["estimatedActualArrivalUTC"];
      scheduledDeparture =
        nextData["props"]["initialState"]["flightTracker"]["flight"][
          "schedule"
        ]["estimatedActualDepartureUTC"];
    } catch (err) {
      const otherDay =
        nextData["props"]["initialState"]["flightTracker"]["otherDays"][0];

      const arrivalTime = otherDay["flights"][0]["arrivalTime24"];

      // const departureDate = `${otherDay["date2"]} ${otherDay["year"]}`;
      const departureTime = otherDay["flights"][0]["departureTime24"];

      scheduledArrival = this.convertToProperMoment(
        toCity,
        departDate,
        arrivalTime
      );
      scheduledDeparture = this.convertToProperMoment(
        fromCity,
        departDate,
        departureTime
      );
    }

    const arrivalTimeMoment = moment.tz(scheduledArrival, arrivalTimezone);
    const departureTimeMoment = moment.tz(
      scheduledDeparture,
      departureTimezone
    );
    return { arrivalTimeMoment, departureTimeMoment };
  }

  getFlightDetails($, segmentDetail) {
    const airlineAndFlight = $(segmentDetail)
      .text()
      .trim()
      .split(" ")[0];
    const airline = airlineAndFlight.substr(0, 2).trim();
    const flightNumber = airlineAndFlight.substr(2).trim();
    // Type of plane
    const aircraft = "-";
    return { aircraft, airline, flightNumber };
  }

  /**
   *
   * @param {moment} departTime
   * @param {moment} arrivalTime
   */
  calculateLagDays(departDate, arrivalDate) {
    const lag = moment(arrivalDate).diff(moment(departDate), "days");
    return lag;
  }

  /**
   *
   * @param {String} toCityString "arrival airport code LHR" or "layover airport code AMS layover duration1h  25m"
   */
  extractConnectionDetails(toCityString) {
    let toCity, nextConnectionMinutes;
    toCityString = toCityString.replace(/[\r\n]+/gm, "");
    toCityString = toCityString.replace(/\W+/gm, " ");
    let matching;
    if (
      (matching = toCityString.match(
        /layover airport code (.*) layover duration(.*)/
      ))
    ) {
      toCity = matching[1].trim();
      const nextConnection = matching[2].trim();
      let nextConnectionMoment = moment(nextConnection, "hh:mm a");
      if (!nextConnectionMoment.isValid()) {
        nextConnectionMoment = moment(nextConnection, "mm");
      }
      let nextConnectionInFormat = nextConnectionMoment.format("HH:mm");
      nextConnectionMinutes = moment
        .duration(nextConnectionInFormat)
        .asMinutes();
    } else {
      matching = toCityString.match(/arrival airport code (.*)/);
      toCity = matching[1].trim();
    }
    return { toCity, nextConnectionMinutes };
  }

  parseCabin(ele) {
    const displayCodes = {
      "Economy Classic": cabins.economy,
      "Basic Cabin": cabins.economy,
      Economy: cabins.economy,
      "Economy Delight": cabins.economy,
      "Comfort+": cabins.economy,
      Main: cabins.economy,
      "Premium Select": cabins.premium,
      Premium: cabins.premium,
      "Delta One": cabins.business,
      "Upper Class": cabins.business,
      First: cabins.first
    };

    for (var cabinClass in displayCodes) {
      if (ele.text().indexOf(cabinClass) !== -1) {
        return displayCodes[cabinClass];
      }
    }
  }

  calculateNumberOfLayovers($, row) {
    const isNonStop = $(row)
      .find(".fareIconBadge")
      .text()
      .match("Nonstop");
    if (isNonStop) {
      return 0;
    }
    return $(row).find(".flightStopLayover").length - 1;
  }
};

var request = require("request");
require("request-to-curl");

url = "https://www.delta.com/shop/modals/flightspecific";

headers = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36",
  "Content-Type": "application/json; charset=UTF-8",
  cachekey: "d6469dbe-b47e-4f46-be02-12b900011c7c",
  "Accept-Encoding": "compressed"
};

dataRaw =
  '{"legList":[{"originAirportCode":"BOS","destinationAirportCode":"JFK","schedLocalDepartDate":"2020-03-10T08:30","marketingAirlineCode":"DL","operatingAirlineCode":"9E","classOfServiceList":["NE","NV","SN","OZ"],"flightNumber":"5419"}],"pageId":"dynamic-modal","appId":"sho","channelId":"ecomm"}';

data = {
  legList: [
    {
      originAirportCode: "BOS",
      destinationAirportCode: "JFK",
      schedLocalDepartDate: "2020-03-10T08:30",
      marketingAirlineCode: "DL",
      operatingAirlineCode: "9E",
      classOfServiceList: ["NE", "NV", "SN", "OZ"],
      flightNumber: "5419"
    }
  ],
  pageId: "dynamic-modal",
  appId: "sho",
  channelId: "ecomm"
};

options = {
  url: "https://www.delta.com/shop/modals/flightspecific",
  method: "POST",
  headers: headers,
  "data-raw": dataRaw
};

request(options, function(error, response, body) {
  console.log("error:", error); // Print the error if one occurred
  console.log("statusCode:", response && response.statusCode); // Print the response status code if a response was received
  console.log("body:", body); // Print the HTML for the Google homepage.
  // console.log(response.request.req.toCurl());
  console.log(JSON.stringify(response));
});

/**
 * 
% curl 'https://www.delta.com/shop/modals/flightspecific' \                                                                                                                                               ✹ ✭
-H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36'  \
-H 'content-type: application/json; charset=UTF-8' \
-H 'cachekey: d6469dbe-b47e-4f46-be02-12b900011c7c' \
--data '{"legList":[{"originAirportCode":"BOS","destinationAirportCode":"JFK","schedLocalDepartDate":"2020-03-10T08:30","marketingAirlineCode":"DL","operatingAirlineCode":"9E","classOfServiceList":["NE","NV","SN","OZ"],"flightNumber":"5419"}],"pageId":"dynamic-modal","appId":"sho","channelId":"ecomm"}' \
--compressed

 works

curl 'https://www.delta.com/shop/modals/flightspecific' \
-H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36'  \
-H 'content-type: application/json; charset=UTF-8' \
-H 'cachekey: d6469dbe-b47e-4f46-be02-12b900011c7c' \
-H "Accept-Encoding: compressed" \
--data-raw '{"legList":[{"originAirportCode":"BOS","destinationAirportCode":"JFK","schedLocalDepartDate":"2020-03-10T08:30","marketingAirlineCode":"DL","operatingAirlineCode":"9E","classOfServiceList":["NE","NV","SN","OZ"],"flightNumber":"5419"}],"pageId":"dynamic-modal","appId":"sho","channelId":"ecomm"}'

request(options, function(error, response, body) {
  console.log("error:", error); // Print the error if one occurred
  console.log("statusCode:", response && response.statusCode); // Print the response status code if a response was received
  console.log("body:", body); // Print the HTML for the Google homepage.
  // console.log(response.request.req.toCurl());
  // console.log(JSON.stringify(response));
})

Minimum

*/

const axios = require("axios");

headers = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36",
  "Content-Type": "application/json; charset=UTF-8",
  cachekey: "d6469dbe-b47e-4f46-be02-12b900011c7c",
  "Accept-Encoding": "compressed"
};

data =
  '{"legList":[{"originAirportCode":"BOS","destinationAirportCode":"JFK","schedLocalDepartDate":"2020-03-10T08:30","marketingAirlineCode":"DL","operatingAirlineCode":"9E","classOfServiceList":["NE","NV","SN","OZ"],"flightNumber":"5419"}],"pageId":"dynamic-modal","appId":"sho","channelId":"ecomm"}';

url = "https://www.delta.com/shop/modals/flightspecific";

options = {
  method: "POST",
  headers: headers,
  data: data,
  url: url
};

axios(options).then(function(response) {
  console.log(response);
});
