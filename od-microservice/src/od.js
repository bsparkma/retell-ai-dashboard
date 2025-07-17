"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSlots = getSlots;
exports.bookSlot = bookSlot;
const axios_1 = __importDefault(require("axios"));
const OD = process.env.OD_API_URL;
const HDR = { Authorization: `Bearer ${process.env.OD_API_KEY}` };
function getSlots(params) {
    return __awaiter(this, void 0, void 0, function* () {
        const { data } = yield axios_1.default.get(`${OD}/appointments/slots`, { params, headers: HDR });
        return data;
    });
}
function bookSlot(patNum, slot, defNumApptType) {
    return __awaiter(this, void 0, void 0, function* () {
        const planned = yield axios_1.default.post(`${OD}/appointments/planned`, { PatNum: patNum, defNumApptType }, { headers: HDR });
        const body = {
            AptNum: planned.data.AptNum,
            AptDateTime: slot.DateTimeStart,
            ProvNum: slot.ProvNum,
            Op: slot.OpNum
        };
        return axios_1.default.post(`${OD}/appointments/schedulePlanned`, body, { headers: HDR });
    });
}
