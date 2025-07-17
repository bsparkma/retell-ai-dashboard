import express, { Request, Response } from 'express';
import dotenv  from 'dotenv';
import {getSlots, bookSlot} from './od';
dotenv.config();

const app = express();
app.use(express.json());

// GET SLOTS
app.post('/od/slots', async (req: Request, res: Response) =>{
  try{
    const slots = await getSlots(req.body);
    res.json(slots);
  }catch(e: any){
    console.error(e.response?.data||e);
    res.status(500).json({error:'OD slots fetch failed'});
  }
});

// BOOK SLOT
app.post('/od/book', async (req: Request, res: Response) =>{
  const {patNum, slot, defNumApptType} = req.body;
  try{
    const booked = await bookSlot(patNum, slot, defNumApptType);
    res.json(booked.data);
  }catch(e: any){
    if(e.response?.status===409){
      return res.status(409).json({error:'SlotAlreadyBooked'});
    }
    console.error(e.response?.data||e);
    res.status(500).json({error:'OD booking failed'});
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`OD service on ${PORT}`)); 