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
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const od_1 = require("./od");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// GET SLOTS
app.post('/od/slots', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const slots = yield (0, od_1.getSlots)(req.body);
        res.json(slots);
    }
    catch (e) {
        console.error(((_a = e.response) === null || _a === void 0 ? void 0 : _a.data) || e);
        res.status(500).json({ error: 'OD slots fetch failed' });
    }
}));
// BOOK SLOT
app.post('/od/book', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const { patNum, slot, defNumApptType } = req.body;
    try {
        const booked = yield (0, od_1.bookSlot)(patNum, slot, defNumApptType);
        res.json(booked.data);
    }
    catch (e) {
        if (((_a = e.response) === null || _a === void 0 ? void 0 : _a.status) === 409) {
            return res.status(409).json({ error: 'SlotAlreadyBooked' });
        }
        console.error(((_b = e.response) === null || _b === void 0 ? void 0 : _b.data) || e);
        res.status(500).json({ error: 'OD booking failed' });
    }
}));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OD service on ${PORT}`));
