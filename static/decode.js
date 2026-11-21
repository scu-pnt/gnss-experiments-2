// GPS constants
const SAMPLE_RATE = 2.4e6;
const CHIP_RATE = 1.023e6;
const DATA_RATE = 50;
const PRN_PERIOD = 1023;

// acquisition and tracking options
const NUM_INTEGRATIONS_ACQ = 10;                // integration length is set by sample-server 
const NUM_INTEGRATIONS_TRACK = 1;
const FREQ_RANGE = 5e3;                         // Hz
const FREQ_STEP = 250;                          // Hz
const PEAK_RATIO_THRESHOLD = 1.3;

// graphing preferences
let IQ_BUF_LEN = 200;                          // how many IQ points to buffer per channel
let IQ_CONSTELLATION_POINTS = 10;              // how many points get accumulated per constellation draw
let CONSTELLATION_R = 15;

// generate PRN codes
const generate_codes = () => {

    const codes = {};

    const taps = {
        1: [1,5],   2: [2,6],   3: [3,7],   4: [4,8],
        5: [0,8],   6: [1,9],   7: [0,7],   8: [1,8],
        9: [2,9],   10: [1,2],  11: [2,3],  12: [4,5],
        13: [5,6],  14: [6,7],  15: [7,8],  16: [8,9],
        17: [0,3],  18: [1,4],  19: [2,5],  20: [3,6],
        21: [4,7],  22: [5,8],  23: [0,2],  24: [3,5],
        25: [4,6],  26: [5,7],  27: [6,8],  28: [7,9],
        29: [0,5],  30: [1,6],  31: [2,7],  32:[3,8]
    };

    for(const prn in taps) {

        const [tap1, tap2] = taps[prn];
        
        const g1 = new Array(10).fill(1);
        const g2 = new Array(10).fill(1);

        const code = [];

        for(let i = 0; i < PRN_PERIOD; i++) {

            g1.unshift(g1[2] ^ g1[9]);
            const g1_bit = g1.pop();

            const g2_bit = g2[tap1] ^ g2[tap2];
            g2.unshift(g2[1] ^ g2[2] ^ g2[5] ^ g2[7] ^ g2[8] ^ g2[9]);
            g2.pop();

            code.push(g1_bit ^ g2_bit);

        }

        codes[prn] = code;

    }

    return codes;

};

const codes = generate_codes();

// resample code w/ zero-order hold
// sample_i is in samples; code_delay is in chips
// result is rescaled to -1..1
const sample_code = (prn, sample_i, code_delay) => codes[prn][Math.floor(sample_i/SAMPLE_RATE*CHIP_RATE + code_delay) % PRN_PERIOD] * 2 - 1;

// complex multiplication
const cmul = (I1, Q1, I2, Q2) => [I1*I2-Q1*Q2, I1*Q2 + I2*Q1];

// complex sinusoid generation
const nco = (sample_i, freq) => {
    const x = 2*Math.PI*freq*sample_i/SAMPLE_RATE;
    return [Math.cos(x), Math.sin(x)];
};

// receiver state
const channels = [];
const CHANNEL_STATE = {
    NOT_FOUND: "not_found",
    SEARCHING: "searching",
    TRACKING: "tracking"
};

let i = 0;
for(const prn in codes) {
    channels.push({
        prn_num: prn,                       
        state: CHANNEL_STATE.NOT_FOUND,
        //search_cooldown: NUM_INTEGRATIONS_ACQ*i
        search_cooldown: prn == 22 ? 0 : 1e10
    });
    i++;
}

// track how many samples have been processed
let num_samples = 0;

const log_event = str => {
    console.log(str); // TODO make this display somewhere on the webpage
};

const process_samples = ([I,Q]) => {

    for(const channel of channels) {

        if(channel.state == CHANNEL_STATE.TRACKING) {

            if(!channel.IQ) {
                channel.IQ = [];
                channel.integrating_I = [];
                channel.integrating_Q = [];             
            }

            // carrier removal
            const I_freq_shifted = new Float32Array(I.length);
            const Q_freq_shifted = new Float32Array(I.length);
            for(let i = 0; i < I.length; i++) {
                const [nco_i, nco_q] = nco(i+num_samples, channel.freq_shift);
                [I_shifted, Q_shifted] = cmul(I[i], Q[i], nco_i, nco_q);
                I_freq_shifted[i] = I_shifted;
                Q_freq_shifted[i] = Q_shifted;
            }

            // correlate
            let correl_sum_I = 0;
            let correl_sum_Q = 0;
            for(let i = 0; i < I.length; i++) {
                const code = sample_code(channel.prn_num, i+num_samples, channel.code_delay);
                correl_sum_I += code * I_freq_shifted[i];
                correl_sum_Q += code * Q_freq_shifted[i];
            }

            // I&D: when integration buffer is full, take average and add new IQ point
            channel.integrating_I.push(correl_sum_I);
            channel.integrating_Q.push(correl_sum_Q);
            if(channel.integrating_I.length == NUM_INTEGRATIONS_TRACK) {

                let integrated_I = 0, integrated_Q = 0;
                for(let i = 0; i < NUM_INTEGRATIONS_TRACK; i++) {
                    integrated_I += channel.integrating_I[i];
                    integrated_Q += channel.integrating_Q[i];
                }
                channel.integrating_I = [];
                channel.integrating_Q = [];

                channel.IQ = [integrated_I/NUM_INTEGRATIONS_TRACK, integrated_Q/NUM_INTEGRATIONS_TRACK];
                channel.dom.iq_updated = true;

            }

            // refine tracking estimates
            // TODO

        } else if(channel.state == CHANNEL_STATE.SEARCHING) {

            if(!channel.correls) {
                channel.correls = [];
                channel.num_integrations = NUM_INTEGRATIONS_ACQ;
            } 

            // search over frequency range
            let f_bin = 0;
            for(let freq_shift = -FREQ_RANGE; freq_shift <= FREQ_RANGE; freq_shift += FREQ_STEP) {
                
                // frequency shift the signal
                const I_freq_shifted = new Float32Array(I.length);
                for(let i = 0; i < I.length; i++) {
                    const [nco_i, nco_q] = nco(i+num_samples, freq_shift);
                    [I_shifted, _] = cmul(I[i], Q[i], nco_i, nco_q);
                    I_freq_shifted[i] = I_shifted;
                }

                if(!channel.correls[f_bin]) {
                    channel.correls[f_bin] = new Float32Array(PRN_PERIOD);
                }

                // try each code phase
                for(let code_delay = 0; code_delay < PRN_PERIOD; code_delay++) {

                    let correl_sum = 0;
                    for(let i = 0; i < I.length; i++) {
                        correl_sum += sample_code(channel.prn_num, i+num_samples, code_delay) * I_freq_shifted[i];
                    }
                    channel.correls[f_bin][code_delay] += Math.abs(correl_sum);

                }

                f_bin++;
            }

            channel.num_integrations--;
            if(channel.num_integrations == 0) {

                // find max peak, and its code delay/frequency
                let max1 = 0;
                let max1_f_bin = null, max1_delay_bin = null;

                for(let f_bin = 0; f_bin < channel.correls.length; f_bin++) {
                    for(let delay = 0; delay < channel.correls[f_bin].length; delay++) {
                        if(channel.correls[f_bin][delay] > max1) {
                            max1 = channel.correls[f_bin][delay];
                            max1_f_bin = f_bin;
                            max1_delay_bin = delay;
                        }
                    }
                }

                // find secondary peak; ignore ones too close to the max peak
                let max2 = 0;
                for(let f_bin = 0; f_bin < channel.correls.length; f_bin++) {
                    for(let delay = 0; delay < channel.correls[f_bin].length; delay++) {
                        if(channel.correls[f_bin][delay] > max2 && Math.abs(delay - max1_delay_bin) > 5) {
                            max2 = channel.correls[f_bin][delay];
                        }
                    }
                }

                channel.peak_ratio = max1/max2;
                channel.peak_f_bin = max1_f_bin;
                channel.peak_delay_bin = max1_delay_bin;

                if(channel.peak_ratio > PEAK_RATIO_THRESHOLD) {
                    log_event(`acquired PRN ${channel.prn_num} at peak ratio ${channel.peak_ratio}`);
                    channel.state = CHANNEL_STATE.TRACKING;
                    channel.freq_shift = -FREQ_RANGE + max1_f_bin*FREQ_STEP;
                    channel.code_delay = max1_delay_bin;
                } else {
                    channel.state = CHANNEL_STATE.NOT_FOUND;
                    channel.search_cooldown = NUM_INTEGRATIONS_ACQ * 40; // if nothing was found, don't search for another while
                }

                channel.dom.correls_plot_stale = true;

            }

        } else if(channel.state == CHANNEL_STATE.NOT_FOUND) {

            // if the cooldown has expired, start searching!
            channel.search_cooldown--;
            if(channel.search_cooldown <= 0) {
                channel.correls = null;
                channel.state = CHANNEL_STATE.SEARCHING;
            }

        }

    }

    // update global sample counter
    num_samples += I.length;

};

const channel_list = document.getElementById("channels-list");
const channel_template = document.getElementById("channel-template");

const init_displays = () => {
    for(const channel of channels) {

        channel.dom = {};

        const div = channel_template.cloneNode(true);
        div.style.display = "";
        channel.dom.div = div;

        div.querySelector(".prn-num").textContent = channel.prn_num;

        channel.dom.status = div.querySelector(".status");

        channel.dom.search_cooldown = div.querySelector(".search-cooldown");
        channel.dom.cooldown = div.querySelector(".cooldown");

        channel.dom.tracking_stats = div.querySelector(".tracking-stats");
        channel.dom.code_delay = div.querySelector(".code-delay");
        channel.dom.freq_shift = div.querySelector(".freq-shift");
        channel.dom.iq_plot = div.querySelector(".iq-plot");
        channel.dom.iq_plot_ctx = channel.dom.iq_plot.getContext("2d");
        channel.dom.iq_constellation_plot = div.querySelector(".iq-constellation");
        channel.dom.iq_constellation_plot_ctx = channel.dom.iq_constellation_plot.getContext("2d");

        channel.dom.search_progress = div.querySelector(".search-progress");
        channel.dom.num_integrations = div.querySelector(".num-integrations");

        channel.dom.search_results = div.querySelector(".search-results");
        channel.dom.peak_ratio = div.querySelector(".peak-ratio");
        channel.dom.correls_plot = div.querySelector(".correls-plot");
        channel.dom.correls_plot_ctx = channel.dom.correls_plot.getContext("2d");
        channel.dom.correls_plot_raw = div.querySelector(".correls-plot-raw");
        channel.dom.correls_plot_raw_ctx = channel.dom.correls_plot_raw.getContext("2d");

        channel_list.append(div);

    }
};

const plot_correls = channel => {

    const raw_canvas = channel.dom.correls_plot_raw;
    const raw_ctx = channel.dom.correls_plot_raw_ctx;  

    const canvas = channel.dom.correls_plot;
    const ctx = channel.dom.correls_plot_ctx;

    raw_canvas.width = channel.correls[0].length;
    raw_canvas.height = channel.correls.length; 
    const imageData = raw_ctx.createImageData(raw_canvas.width, raw_canvas.height);
    
    // we scale the heatmap by picking some random datapoints, taking their average, and using that as a baseline
    let avg = 0;
    for(let i = 0; i < 10; i++) {
        avg += channel.correls[Math.floor(Math.random()*channel.correls.length)][Math.floor(Math.random()*channel.correls[0].length)];
    }
    avg /= 10;

    for(let f_bin = 0; f_bin < channel.correls.length; f_bin++) {
        for(let delay_bin = 0; delay_bin < channel.correls[0].length; delay_bin++) {
            const idx = (f_bin * channel.correls[0].length + delay_bin) * 4;
            const value = channel.correls[f_bin][delay_bin];
            const scaled = (value/avg)**2*0.1;
            const [r,g,b] = colormap(scaled, MAGMA);
            imageData.data[idx]   = r*255;
            imageData.data[idx+1] = g*255;
            imageData.data[idx+2] = b*255;
            imageData.data[idx+3] = 255;
        }
    }

    raw_ctx.putImageData(imageData, 0, 0);

    // draw the bitmap to the output canvas
    ctx.drawImage(raw_canvas, 0, 0, canvas.width, canvas.height);

    // highlight peak
    ctx.strokeStyle = 'rgba(255,0,0,50%)';
    ctx.beginPath();
    ctx.arc(canvas.width * channel.peak_delay_bin / channel.correls[0].length, canvas.height * channel.peak_f_bin / channel.correls.length, 15, 0, 2 * Math.PI);
    ctx.stroke();

};  

// TODO make this a generally reusable plotting function
const plot_iq_waveform = channel => {

    const canvas = channel.dom.iq_plot, ctx = channel.dom.iq_plot_ctx;

    // scale so that zero is centered and no datapoints are clipped
    let max = 0;
    for(const [I,Q] of channel.dom.iq_buf) {
        max = Math.max(max, Math.abs(I), Math.abs(Q));
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for(const stream of [0,1]) {
        ctx.strokeStyle = ["#ff0000", "#0000ff"][stream];
        ctx.beginPath();
        for(let i = 0; i < channel.dom.iq_buf.length; i++) {
            const value = channel.dom.iq_buf[i][stream];
            const x = i/channel.dom.iq_buf.length * (canvas.width-20) + 10;
            const y = value/max * (canvas.height/2-10) + canvas.height/2;
            if(i == 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }
        ctx.stroke();   
    }

};

const plot_iq_constellation = channel => {

    const canvas = channel.dom.iq_constellation_plot, ctx = channel.dom.iq_constellation_plot_ctx;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // draw guide lines
    ctx.beginPath();
    ctx.moveTo(canvas.width/2, 0);
    ctx.lineTo(canvas.width/2, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, canvas.height/2);
    ctx.lineTo(canvas.width, canvas.height/2);
    ctx.stroke();

    for(const [I,Q] of channel.dom.iq_points_buf) {
        ctx.beginPath();
        ctx.arc(canvas.width/2 + I*CONSTELLATION_R, canvas.height/2 + Q*CONSTELLATION_R, 2, 0, 2 * Math.PI);
        ctx.fill();
    }

};

const update_displays = () => {

    for(const channel of channels) {
        
        channel.dom.status.textContent = channel.state;
        
        // show cooldown only when waiting
        if(channel.state == CHANNEL_STATE.NOT_FOUND) {
            channel.dom.search_cooldown.style.display = "";
            channel.dom.cooldown.textContent = channel.search_cooldown;
        } else {
            channel.dom.search_cooldown.style.display = "none";
        }

        // only show tracking stats when tracking loop is active
        if(channel.state == CHANNEL_STATE.TRACKING) {
            
            channel.dom.tracking_stats.style.display = "";
            channel.dom.code_delay.textContent = channel.code_delay;
            channel.dom.freq_shift.textContent = channel.freq_shift;

            // if new iq points are available...
            if(channel.dom.iq_updated) {
                
                // update the waveform buffer
                if(!channel.dom.iq_buf) {
                    channel.dom.iq_buf = [];
                }
                channel.dom.iq_buf.push(channel.IQ);
                if(channel.dom.iq_buf.length > IQ_BUF_LEN) {
                    channel.dom.iq_buf.shift();
                }

                // update the constellation buffer
                if(!channel.dom.iq_points_buf) {
                    channel.dom.iq_points_buf = [];
                }
                channel.dom.iq_points_buf.push(channel.IQ);
                if(channel.dom.iq_points_buf.length > IQ_CONSTELLATION_POINTS) {
                    plot_iq_constellation(channel);
                    channel.dom.iq_points_buf = [];
                }

                plot_iq_waveform(channel);
                channel.dom.iq_plot_stale = false;
            }

        } else {
            channel.dom.tracking_stats.style.display = "none";
        }

        // if acquisition data is available, show it
        if(channel.num_integrations > 0) {
            channel.dom.search_results.style.display = "none";
            channel.dom.search_progress.style.display = "";
            channel.dom.num_integrations.textContent = `${NUM_INTEGRATIONS_ACQ - channel.num_integrations} / ${NUM_INTEGRATIONS_ACQ}`;
        } else if(channel.num_integrations == 0) {
            
            channel.dom.search_results.style.display = "";
            channel.dom.search_progress.style.display = "none";
            channel.dom.peak_ratio.textContent = Number(channel.peak_ratio).toPrecision(3);

            if(channel.dom.correls_plot_stale) {
                plot_correls(channel);
                channel.dom.correls_plot_stale = false;
            }

        } 

    }

    document.getElementById("sample-rate").textContent = (SAMPLE_RATE/1e6).toPrecision(3);
    document.getElementById("acquisition-settings").textContent = `${NUM_INTEGRATIONS_ACQ} integration(s); frequency range = \xB1${FREQ_RANGE} Hz, step = ${FREQ_STEP} Hz; peak ratio threshold = ${PEAK_RATIO_THRESHOLD}`;
    document.getElementById("num-samples").textContent = num_samples;

};

const tick = () => {
    fetch(`/samples?n=${encodeURIComponent(num_samples)}`)
        .then(resp => resp.json())
        .then(data => {
            if(data) {
                process_samples(data);
                update_displays();
                setTimeout(tick, 1000 / 5);
            }
        });
};

init_displays();
tick();