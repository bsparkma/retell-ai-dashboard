import axios from 'axios';

const OD = process.env.OD_API_URL;
const HDR = { Authorization: `Bearer ${process.env.OD_API_KEY}` };

export async function getSlots(params: Record<string, any>): Promise<any> {
  const {data} = await axios.get(`${OD}/appointments/slots`, { params, headers:HDR });
  return data;
}

export async function bookSlot(patNum: number, slot: any, defNumApptType: number): Promise<any> {
  const planned = await axios.post(`${OD}/appointments/planned`,
      {PatNum:patNum, defNumApptType}, {headers:HDR});
  const body = {
    AptNum: (planned.data as any).AptNum,
    AptDateTime: slot.DateTimeStart,
    ProvNum: slot.ProvNum,
    Op: slot.OpNum
  };
  return axios.post(`${OD}/appointments/schedulePlanned`, body, {headers:HDR});
} 