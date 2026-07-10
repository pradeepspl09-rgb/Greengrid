/**
 * UrjaPrabandh Test Runner
 * Validates Microgrid Controller Logic under extreme scenarios
 */

const MicrogridController = require('./app.js');

function assert(condition, message) {
    if (!condition) {
        console.error(`\x1b[31m[FAIL] ${message}\x1b[0m`);
        process.exit(1);
    }
}

function runTests() {
    console.log("=========================================");
    console.log("RUNNING GREENGRID INDIA SMART CONTROLLER TESTS");
    console.log("=========================================");

    // Test Case 1: Normal Sunny Day Solar Surplus & Grid Export
    (() => {
        console.log("\n[Test 1] Testing Solar Surplus and Grid Export...");
        const mc = new MicrogridController();
        mc.reset();
        mc.weather = 'sunny';
        mc.time = 12.0; // Peak solar hour
        mc.batterySoC = 96.0; // Battery already full
        mc.gridAvailable = true;
        mc.isAgPumpScheduled = false; // No agricultural pump to ensure surplus

        // Simulate environment and run EMS for 1 hour
        mc.simulateEnvironment(1.0);
        mc.runEMS(1.0);

        console.log(`- Solar Generation: ${mc.solarGenKW.toFixed(2)} kW`);
        console.log(`- Wind Generation: ${mc.windGenKW.toFixed(2)} kW`);
        console.log(`- Battery SoC: ${mc.batterySoC.toFixed(2)}%`);
        console.log(`- Grid Power: ${mc.gridNetPowerKW.toFixed(2)} kW (Positive = Export)`);

        assert(mc.solarGenKW > 15.0, "Solar generation should be high at noon");
        assert(mc.gridNetPowerKW > 0.0, "Grid should be exporting surplus power");
        assert(mc.batteryNetPowerKW === 0.0, "Battery should not charge since SoC > 95%");
        assert(mc.mode === 'NORMAL', "System mode should be NORMAL");
        console.log("\x1b[32m[PASS] Test 1: Solar surplus exported successfully.\x1b[0m");
    })();

    // Test Case 2: Peak Tariff Load Minimization (TOD Tariff)
    (() => {
        console.log("\n[Test 2] Testing Peak Tariff Battery Discharge...");
        const mc = new MicrogridController();
        mc.reset();
        mc.weather = 'overcast'; // low renewables
        mc.time = 19.0; // Peak tariff hour (6 PM - 10 PM)
        mc.batterySoC = 80.0; // Healthy battery
        mc.gridAvailable = true;
        mc.isAgPumpScheduled = false;

        // Run EMS
        mc.simulateEnvironment(1.0);
        mc.runEMS(1.0);

        console.log(`- Solar Generation: ${mc.solarGenKW.toFixed(2)} kW`);
        console.log(`- Grid Tariff Rate: ₹${mc.getTariffRate(mc.time)}/kWh`);
        console.log(`- Battery Discharge: ${mc.batteryNetPowerKW.toFixed(2)} kW (Negative = Discharge)`);
        console.log(`- Grid Import: ${mc.gridNetPowerKW.toFixed(2)} kW`);

        assert(mc.batteryNetPowerKW < 0.0, "Battery should discharge to avoid peak grid tariff");
        assert(Math.abs(mc.gridNetPowerKW) < (mc.criticalLoadBaseKW + mc.domesticLoadBaseKW), "Grid import should be reduced due to battery support");
        console.log("\x1b[32m[PASS] Test 2: Peak tariff grid import minimized successfully.\x1b[0m");
    })();

    // Test Case 3: Blackout & Load-Shedding Escalation
    (() => {
        console.log("\n[Test 3] Testing Blackout & Emergency Load-Shedding Escalation...");
        const mc = new MicrogridController();
        mc.reset();
        mc.weather = 'overcast';
        mc.time = 12.0; // Noon, during active agricultural pump hours
        mc.gridAvailable = false; // Grid failure!
        mc.batterySoC = 25.0; // Low battery (trigger pump shedding)
        mc.isAgPumpScheduled = true; // High agricultural demand

        // Simulate environment and override generation to 0 for strict blackout test
        mc.simulateEnvironment(1.0);
        mc.solarGenKW = 0.0;
        mc.windGenKW = 0.0;
        mc.runEMS(1.0);

        console.log(`- Mode after Grid Failure: ${mc.mode}`);
        console.log(`- Ag Pump Shedded: ${mc.agPumpShed}`);
        console.log(`- Biomass Generator Output: ${mc.biomassGenKW.toFixed(2)} kW`);
        console.log(`- Battery Discharge Rate: ${mc.batteryNetPowerKW.toFixed(2)} kW`);

        assert(mc.mode === 'LOAD_SHEDDING', "Mode should be LOAD_SHEDDING");
        assert(mc.agPumpShed === true, "Ag pump should be shedded immediately");
        assert(mc.biomassGenKW > 0.0, "Biomass backup generator should start up");

        // 2. Further degrade battery to test emergency shedding (Battery SoC < 10% / Emergency)
        mc.batterySoC = 9.0;
        mc.runEMS(1.0);

        console.log(`- Mode at <10% SoC: ${mc.mode}`);
        console.log(`- Domestic Load Shedded: ${mc.domesticShed}`);
        console.log(`- Critical Load Shedded: ${mc.criticalShed}`);

        assert(mc.mode === 'EMERGENCY', "Mode should escalate to EMERGENCY");
        assert(mc.domesticShed === true, "Domestic loads should be shedded to save battery/critical services");
        assert(mc.criticalShed === false, "Critical services (clinic) should still be active");

        console.log("\x1b[32m[PASS] Test 3: Load shedding safety escalation verified.\x1b[0m");
    })();

    console.log("\n=========================================");
    console.log("\x1b[32mALL TESTS PASSED SUCCESSFULLY! (3/3)\x1b[0m");
    console.log("=========================================");
}

runTests();
