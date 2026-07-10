/**
 * GreenGrid India — Smart Community Renewable Energy Controller
 * Core Simulation & Energy Management Engine
 * Supports both simulated data and live real-world data injection.
 */

class MicrogridController {
    constructor() {
        // System Hardware Specifications
        this.solarCapacityKW   = 25.0;   // 25 kW solar panel array
        this.windCapacityKW    = 10.0;   // 10 kW wind turbine
        this.biomassMaxKW      = 10.0;   // 10 kW biogas generator
        this.batteryCapacityKWh = 50.0;  // 50 kWh LFP battery bank
        this.batteryMaxChargeKW    = 15.0;
        this.batteryMaxDischargeKW = 15.0;

        // Village Load Specifications
        this.criticalLoadBaseKW = 5.0;   // Clinic, water pump motor, street lights
        this.domesticLoadBaseKW = 10.0;  // Homes: fans, lights, TVs, small appliances
        this.agPumpLoadBaseKW   = 12.0;  // Irrigation pump (heavy load)

        // Live Data Mode
        this.liveMode = false;           // True when real API data is being used
        this.liveLocationName = '';      // e.g. "New Delhi, India"

        this.reset();
    }

    reset() {
        // Use real current IST time
        const now = new Date();
        this.time = now.getHours() + now.getMinutes() / 60.0 + now.getSeconds() / 3600.0;

        this.simSpeed  = 0;             // Default: paused — driven by real clock
        this.weather   = 'sunny';

        // Live sensor readings (injected from API or computed from simulation)
        this.solarRadiationWm2 = 0;     // Real solar irradiance in W/m²
        this.realWindSpeedMs   = 0;     // Real wind speed in m/s
        this.realTemperatureC  = 30;    // Real ambient temperature °C

        this.solarGenKW   = 0.0;
        this.windGenKW    = 0.0;
        this.biomassGenKW = 0.0;

        this.batterySoC        = 50.0;
        this.batteryNetPowerKW = 0.0;

        this.gridAvailable  = true;
        this.gridNetPowerKW = 0.0;

        this.isAgPumpScheduled = true;
        this.isBiomassOverride = false;

        this.criticalShed = false;
        this.domesticShed = false;
        this.agPumpShed   = false;

        this.mode = 'NORMAL';

        // Cumulative Totals (reset daily at midnight)
        this.cumSolarKWh      = 0.0;
        this.cumWindKWh       = 0.0;
        this.cumBiomassKWh    = 0.0;
        this.cumGridImportKWh = 0.0;
        this.cumGridExportKWh = 0.0;
        this.cumSavingsINR    = 0.0;
        this.cumCO2SavedKg    = 0.0;    // 0.82 kg CO2 saved per clean kWh vs coal grid
    }

    // ─── Time-of-Day Tariff (Indian TOD Structure) ────────────────────────────

    getTariffRate(hour) {
        if (hour >= 18.0 && hour < 22.0) return 10.0;  // Peak evening: ₹10/kWh
        if (hour >= 22.0 || hour < 6.0)  return 4.0;   // Off-peak night: ₹4/kWh
        return 6.5;                                      // Normal day: ₹6.5/kWh
    }

    getExportRate() {
        return 4.5;   // Net-metering feed-in tariff: ₹4.5/kWh (flat)
    }

    // ─── Environment Simulator (used when live data is unavailable) ──────────

    simulateEnvironment(deltaTimeHours) {
        const hour = this.time;

        // Solar: sine-curve peak at noon, zero at night
        let solarBase = 0.0;
        if (hour > 6.0 && hour < 18.0) {
            solarBase = Math.sin((hour - 6.0) / 12.0 * Math.PI) * this.solarCapacityKW;
        }
        const solarMod = { sunny: 1.0, windy: 0.8, overcast: 0.4, monsoon: 0.2 }[this.weather] || 1.0;
        this.solarGenKW = solarBase * solarMod;

        // Wind: stochastic, higher at night, boosted by windy/monsoon weather
        let windBase = 2.0 + Math.random() * 3.0;
        if (hour >= 18.0 || hour <= 6.0) windBase += 1.5;
        const windMod = { windy: 2.5, monsoon: 1.5, overcast: 0.8, sunny: 0.6 }[this.weather] || 1.0;
        this.windGenKW = Math.min(this.windCapacityKW, windBase * windMod);
    }

    // ─── Live Data Injection (called by the API fetcher in index.html) ────────

    /**
     * Inject real-world sensor readings from Open-Meteo API.
     * @param {number} radiationWm2  - Shortwave solar radiation in W/m²
     * @param {number} windSpeedMs   - Wind speed in m/s at 10 m height
     * @param {number} temperatureC  - Ambient air temperature in °C
     * @param {string} weatherProfile - 'sunny' | 'overcast' | 'monsoon' | 'windy'
     */
    injectLiveData(radiationWm2, windSpeedMs, temperatureC, weatherProfile) {
        this.liveMode = true;

        // Store raw readings for display
        this.solarRadiationWm2 = radiationWm2;
        this.realWindSpeedMs   = windSpeedMs;
        this.realTemperatureC  = temperatureC;
        this.weather           = weatherProfile;

        // Map real solar irradiance → panel output (Standard Test Condition = 1000 W/m²)
        // Apply a real-world performance ratio of 0.80 (accounting for heat, wiring losses)
        const PR = 0.80;
        this.solarGenKW = Math.min(
            this.solarCapacityKW,
            (radiationWm2 / 1000.0) * this.solarCapacityKW * PR
        );

        // Map real wind speed → turbine output using simplified cubic power curve
        // Rated speed assumed at 12 m/s, cut-in at 2.5 m/s, cut-out at 25 m/s
        if (windSpeedMs < 2.5 || windSpeedMs > 25.0) {
            this.windGenKW = 0.0;
        } else {
            const fraction = Math.min(1.0, Math.pow(windSpeedMs / 12.0, 3));
            this.windGenKW = Math.min(this.windCapacityKW, fraction * this.windCapacityKW);
        }
    }

    // ─── Core Energy Management System (EMS) ──────────────────────────────────

    runEMS(deltaTimeHours) {
        let reqCritical = this.criticalLoadBaseKW;
        let reqDomestic = this.domesticLoadBaseKW;
        const isAgTime  = (this.time >= 9.0 && this.time <= 15.0);
        let reqAg       = (this.isAgPumpScheduled && isAgTime) ? this.agPumpLoadBaseKW : 0.0;

        this.criticalShed = false;
        this.domesticShed = false;
        this.agPumpShed   = false;

        let totalGen = this.solarGenKW + this.windGenKW;
        this.biomassGenKW = 0.0;

        if (this.isBiomassOverride) {
            this.biomassGenKW = this.biomassMaxKW;
            totalGen += this.biomassGenKW;
        }

        let netPower    = totalGen - (reqCritical + reqDomestic + reqAg);
        let battPower   = 0.0;
        let gridPower   = 0.0;

        if (this.gridAvailable) {
            this.mode = 'NORMAL';

            if (netPower >= 0) {
                // Surplus: charge battery first, export remainder
                if (this.batterySoC < 95.0) {
                    const maxChg = Math.min(
                        this.batteryMaxChargeKW,
                        netPower,
                        ((95.0 - this.batterySoC) / 100.0) * this.batteryCapacityKWh / Math.max(deltaTimeHours, 0.001)
                    );
                    battPower = maxChg;
                    netPower -= battPower;
                }
                gridPower = netPower;   // export (positive)
            } else {
                // Deficit: use battery during peak tariff to avoid expensive grid import
                let deficit = Math.abs(netPower);
                const isPeak = this.getTariffRate(this.time) >= 10.0;

                if (isPeak && this.batterySoC > 30.0) {
                    const maxDis = Math.min(
                        this.batteryMaxDischargeKW,
                        deficit,
                        ((this.batterySoC - 30.0) / 100.0) * this.batteryCapacityKWh / Math.max(deltaTimeHours, 0.001)
                    );
                    battPower = -maxDis;
                    deficit  -= maxDis;
                }

                gridPower = -deficit;   // import (negative)

                // Trickle-charge battery from off-peak grid if SoC is very low
                if (this.batterySoC < 25.0 && !isPeak) {
                    const trickle = 5.0;
                    gridPower  -= trickle;
                    battPower  += trickle;
                }
            }

        } else {
            // Islanded Mode (Grid Outage)
            this.mode = 'ISLANDED';
            gridPower = 0.0;

            if (netPower >= 0) {
                // Surplus: charge battery (excess RE curtailed)
                if (this.batterySoC < 95.0) {
                    battPower = Math.min(
                        this.batteryMaxChargeKW,
                        netPower,
                        ((95.0 - this.batterySoC) / 100.0) * this.batteryCapacityKWh / Math.max(deltaTimeHours, 0.001)
                    );
                }
            } else {
                let deficit = -netPower;

                // Discharge battery (down to 20% in islanded mode)
                if (this.batterySoC > 20.0) {
                    const maxDis = Math.min(
                        this.batteryMaxDischargeKW,
                        deficit,
                        ((this.batterySoC - 20.0) / 100.0) * this.batteryCapacityKWh / Math.max(deltaTimeHours, 0.001)
                    );
                    battPower = -maxDis;
                    deficit  -= maxDis;
                }

                if (deficit > 0) {
                    this.mode = 'LOAD_SHEDDING';

                    // 1. Shed agricultural pump first
                    if (reqAg > 0) {
                        this.agPumpShed = true;
                        deficit -= reqAg;
                        reqAg = 0;
                    }

                    // 2. Start biogas backup generator
                    if (deficit > 0 && !this.isBiomassOverride) {
                        const needed = Math.min(this.biomassMaxKW, deficit);
                        this.biomassGenKW = needed;
                        deficit -= needed;
                    }

                    // 3. Emergency battery discharge (down to 10%)
                    if (deficit > 0 && this.batterySoC > 10.0) {
                        const emgDis = Math.min(
                            this.batteryMaxDischargeKW + battPower,
                            deficit,
                            ((this.batterySoC - 10.0) / 100.0) * this.batteryCapacityKWh / Math.max(deltaTimeHours, 0.001)
                        );
                        battPower -= emgDis;
                        deficit   -= emgDis;
                    }

                    // 4. Shed domestic loads
                    if (deficit > 0) {
                        this.mode = 'EMERGENCY';
                        this.domesticShed = true;
                        deficit -= reqDomestic;
                        reqDomestic = 0;
                    }

                    // 5. Last resort: shed critical loads
                    if (deficit > 0) {
                        this.criticalShed = true;
                    }
                }
            }
        }

        // Apply SoC change (only meaningful when deltaTimeHours > 0)
        if (deltaTimeHours > 0) {
            let deltaSoC = 0;
            if (battPower > 0) {
                deltaSoC = (battPower * 0.95 * deltaTimeHours) / this.batteryCapacityKWh * 100.0;
            } else if (battPower < 0) {
                deltaSoC = (battPower / 0.95 * deltaTimeHours) / this.batteryCapacityKWh * 100.0;
            }
            this.batterySoC = Math.max(0.0, Math.min(100.0, this.batterySoC + deltaSoC));
        }

        this.batteryNetPowerKW = battPower;
        this.gridNetPowerKW    = gridPower;

        // ── Cumulative Statistics ──────────────────────────────────────────────
        if (deltaTimeHours > 0) {
            this.cumSolarKWh   += this.solarGenKW * deltaTimeHours;
            this.cumWindKWh    += this.windGenKW  * deltaTimeHours;
            this.cumBiomassKWh += this.biomassGenKW * deltaTimeHours;

            if (this.gridNetPowerKW < 0) {
                this.cumGridImportKWh += Math.abs(this.gridNetPowerKW) * deltaTimeHours;
            } else {
                this.cumGridExportKWh += this.gridNetPowerKW * deltaTimeHours;
            }

            this.cumCO2SavedKg += (this.solarGenKW + this.windGenKW) * deltaTimeHours * 0.82;

            // Financial savings vs. buying 100% from grid
            const totalServedLoad = (this.criticalShed ? 0 : reqCritical)
                                  + (this.domesticShed ? 0 : reqDomestic)
                                  + (this.agPumpShed   ? 0 : reqAg);

            const tariff              = this.getTariffRate(this.time);
            const costWithoutMicrogrid = totalServedLoad * tariff * deltaTimeHours;
            const gridCost  = (this.gridNetPowerKW < 0) ? Math.abs(this.gridNetPowerKW) * tariff * deltaTimeHours : 0;
            const gridEarn  = (this.gridNetPowerKW > 0) ? this.gridNetPowerKW * this.getExportRate() * deltaTimeHours : 0;
            const biomassCost = this.biomassGenKW * 3.5 * deltaTimeHours;

            this.cumSavingsINR += (costWithoutMicrogrid - (gridCost - gridEarn + biomassCost));
        }
    }

    /**
     * Tick the simulation clock forward by elapsedSeconds of real time.
     * When in live mode, the clock is driven externally by the real IST clock.
     */
    tick(elapsedSeconds) {
        if (this.liveMode) {
            // Real-time: sync to actual clock, compute energy over the elapsed delta
            const now  = new Date();
            this.time  = now.getHours() + now.getMinutes() / 60.0 + now.getSeconds() / 3600.0;
            const deltaTimeHours = elapsedSeconds / 3600.0;
            // In live mode, environment is already injected; just run EMS
            this.runEMS(deltaTimeHours);
        } else {
            // Simulation mode: advance clock at simSpeed
            const deltaMinutes   = elapsedSeconds * this.simSpeed;
            const deltaTimeHours = deltaMinutes / 60.0;
            this.time = (this.time + deltaTimeHours) % 24.0;
            this.simulateEnvironment(deltaTimeHours);
            this.runEMS(deltaTimeHours);
        }
    }
}

// Export for Node.js test runner
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MicrogridController;
}
